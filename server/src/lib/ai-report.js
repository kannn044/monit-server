// Report generation.
//
// The rule that shapes this whole file: the model never writes HTML, and it
// never writes a number. It writes prose about numbers that are already fixed.
//
// A local model asked for "an HTML report" produces markup that is slow to
// generate, frequently malformed, and — much worse — full of figures it
// half-remembered from the prompt. So the work is split: SQL builds the
// dataset, the model fills a JSON schema with the interpretation, and the
// renderer here puts the two together. The chart is drawn from the dataset, so
// a chart cannot disagree with the database no matter what the model says.

import { q } from '../db/pool.js';
import { llmJson } from './ai-llm.js';
import { fleetSnapshot, ndbSummary } from './ai-analytics.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const n1 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const gb = (kbv) => (kbv === null || kbv === undefined ? '—' : `${(Number(kbv) / 1024 / 1024).toFixed(1)} GB`);

export const REPORT_KINDS = {
  fleet_health: 'Fleet health scorecard',
  critical: 'Critical servers brief',
  capacity: 'Capacity forecast',
  ndb_topology: 'MySQL NDB cluster topology',
};

// ---------------------------------------------------------------------------
// datasets
// ---------------------------------------------------------------------------

/**
 * A health score that is arithmetic, not opinion.
 *
 * Deliberately simple and written down so it can be argued with: the point of a
 * score is that two servers can be ordered, and an unexplainable score is worse
 * than a crude one.
 */
function scoreServer(s) {
  if (s.health === 'offline') return { score: 0, why: ['no samples — offline'] };
  let score = 100;
  const why = [];
  const cpu = Number(s.stats24?.cpu_p95);
  const ram = Number(s.sample?.ram?.used_pct);
  const disk = Number(s.worstDisk?.used_pct);
  const cores = Number(s.stats24?.cores) || Number(s.sample?.load?.cores);
  const sat = cores > 0 ? Number(s.sample?.load?.['1m']) / cores : null;

  if (cpu > 90) { score -= 20; why.push(`cpu p95 ${n1(cpu)}%`); }
  else if (cpu > 75) { score -= 10; why.push(`cpu p95 ${n1(cpu)}%`); }
  if (ram > 92) { score -= 20; why.push(`ram ${n1(ram)}%`); }
  else if (ram > 85) { score -= 10; why.push(`ram ${n1(ram)}%`); }
  if (disk > 92) { score -= 20; why.push(`disk ${n1(disk)}%`); }
  else if (disk > 80) { score -= 8; why.push(`disk ${n1(disk)}%`); }
  if (sat !== null && sat > 1.2) { score -= 12; why.push(`load ${n1(sat)}x cores`); }
  if (s.daysToFull !== null && s.daysToFull < 14) { score -= 15; why.push(`disk full in ${s.daysToFull.toFixed(1)}d`); }
  if (s.missingServices.length) { score -= 12; why.push(`${s.missingServices.length} expected service(s) not running`); }
  for (const i of s.incidents) score -= i.severity === 'critical' ? 18 : 8;
  if (s.incidents.length) why.push(`${s.incidents.length} open incident(s)`);
  if (Math.abs(s.cpuZ ?? 0) > 3 || Math.abs(s.ramZ ?? 0) > 3) { score -= 8; why.push('outside its own normal for this hour'); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), why };
}

async function datasetFleetHealth(snap) {
  const rows = snap.list.map((s) => {
    const { score, why } = scoreServer(s);
    return {
      name: s.name, id: s.id, health: s.health, score, why,
      cpu: n1(s.sample?.cpu?.total), cpu_p95: n1(s.stats24?.cpu_p95),
      ram: n1(s.sample?.ram?.used_pct), ram_p95: n1(s.stats24?.ram_p95),
      disk: n1(s.worstDisk?.used_pct), disk_mount: s.worstDisk?.mount || null,
      incidents: s.incidents.length,
    };
  }).sort((a, b) => a.score - b.score);

  const { rows: recent } = await q(
    `SELECT severity, count(*)::int AS n FROM incidents
      WHERE started_at > now() - interval '7 days' GROUP BY severity`);

  return {
    kind: 'fleet_health',
    title: 'Fleet health scorecard',
    subtitle: `${snap.totals.servers} servers · ${snap.totals.incidents} open incidents`,
    stats: [
      { label: 'Servers', value: snap.totals.servers },
      { label: 'Online', value: snap.totals.online, tone: 'ok' },
      { label: 'Warning', value: snap.totals.warning, tone: 'warn' },
      { label: 'Critical', value: snap.totals.critical, tone: 'crit' },
      { label: 'Offline', value: snap.totals.offline, tone: 'muted' },
      { label: 'Incidents (7d)', value: recent.reduce((a, r) => a + r.n, 0) },
    ],
    bars: {
      title: 'Health score — lowest first',
      unit: '/100',
      items: rows.slice(0, 14).map((r) => ({
        label: r.name, value: r.score, max: 100,
        tone: r.score < 50 ? 'crit' : r.score < 75 ? 'warn' : 'ok',
      })),
    },
    table: {
      title: 'Every server',
      cols: ['Server', 'Health', 'Score', 'CPU now / p95', 'RAM now / p95', 'Worst disk', 'Open'],
      rows: rows.map((r) => [
        r.name, r.health, `${r.score}`,
        `${r.cpu ?? '—'}% / ${r.cpu_p95 ?? '—'}%`,
        `${r.ram ?? '—'}% / ${r.ram_p95 ?? '—'}%`,
        r.disk === null ? '—' : `${r.disk}% ${r.disk_mount || ''}`,
        `${r.incidents}`,
      ]),
    },
    facts: rows.slice(0, 20).map((r) => `${r.name}: score ${r.score}, ${r.health}, `
      + `cpu ${r.cpu}%/p95 ${r.cpu_p95}%, ram ${r.ram}%/p95 ${r.ram_p95}%, disk ${r.disk}% ${r.disk_mount || ''}, `
      + `open incidents ${r.incidents}${r.why.length ? ` — deductions: ${r.why.join('; ')}` : ''}`).join('\n'),
  };
}

async function datasetCritical(snap) {
  const bad = snap.list
    .filter((s) => s.health === 'critical' || s.health === 'warning' || s.health === 'offline'
      || s.incidents.length || s.missingServices.length
      || (s.daysToFull !== null && s.daysToFull < 21))
    .sort((a, b) => scoreServer(a).score - scoreServer(b).score);

  return {
    kind: 'critical',
    title: 'Critical servers brief',
    subtitle: bad.length ? `${bad.length} server(s) need attention` : 'Nothing needs attention right now',
    stats: [
      { label: 'Critical', value: snap.totals.critical, tone: 'crit' },
      { label: 'Warning', value: snap.totals.warning, tone: 'warn' },
      { label: 'Offline', value: snap.totals.offline, tone: 'muted' },
      { label: 'Open incidents', value: snap.totals.incidents },
    ],
    table: {
      title: 'Servers needing attention',
      cols: ['Server', 'Health', 'Why', 'Open incidents'],
      rows: bad.map((s) => [
        s.name, s.health,
        scoreServer(s).why.join('; ') || '—',
        s.incidents.map((i) => `${i.rule_name} (${i.severity})`).join(', ') || '—',
      ]),
    },
    incidents: snap.incidents.slice(0, 20).map((i) => ({
      id: i.id, server: snap.byId[i.server_id]?.name || i.server_id,
      severity: i.severity, status: i.status, rule: i.rule_name,
      metric: i.metric, value: n1(i.value), threshold: i.threshold,
      since: i.started_at,
    })),
    facts: bad.length
      ? bad.map((s) => {
        const { why } = scoreServer(s);
        return `${s.name} [${s.health}] — ${why.join('; ') || 'no deductions'}; `
          + `cpu ${n1(s.sample?.cpu?.total)}% ram ${n1(s.sample?.ram?.used_pct)}% `
          + `disk ${n1(s.worstDisk?.used_pct)}% (${s.worstDisk?.mount || '—'}); `
          + `incidents: ${s.incidents.map((i) => `${i.rule_name} ${i.metric} now ${n1(i.value)} vs ${i.threshold}`).join(' | ') || 'none'}`;
      }).join('\n')
      : 'Every server is online with no open incidents and no projected disk exhaustion within 21 days.',
  };
}

async function datasetCapacity(snap) {
  const rows = snap.list
    .filter((s) => s.health !== 'offline')
    .map((s) => ({
      name: s.name,
      mount: s.worstDisk?.mount || null,
      used_pct: n1(s.worstDisk?.used_pct),
      avail_kb: s.worstDisk?.avail_kb ?? null,
      days: s.daysToFull,
      // Derived from the per-mount fit rather than metrics_1h.disk_used_pct:
      // that column is the max across mounts, which is /boot on most hosts and
      // therefore perfectly flat — it reported "0%/day" for a root filesystem
      // losing 9GB a day.
      disk_slope: s.capacity?.kb_per_sec && Number(s.capacity.size_kb) > 0
        ? n1((-Number(s.capacity.kb_per_sec) * 86400 * 100) / Number(s.capacity.size_kb))
        : null,
      ram: n1(s.sample?.ram?.used_pct),
      ram_slope: n1(s.trend?.ram_pct_per_day),
      total_pct: n1(s.diskTotalPct),
    }))
    .sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));

  const soon = rows.filter((r) => r.days !== null && r.days < 60);
  return {
    kind: 'capacity',
    title: 'Capacity forecast',
    subtitle: soon.length
      ? `${soon.length} mount(s) projected to fill within 60 days`
      : 'No mount is projected to fill within 60 days',
    stats: [
      { label: 'Within 7 days', value: rows.filter((r) => r.days !== null && r.days < 7).length, tone: 'crit' },
      { label: 'Within 30 days', value: rows.filter((r) => r.days !== null && r.days < 30).length, tone: 'warn' },
      { label: 'Servers measured', value: rows.length },
    ],
    bars: soon.length ? {
      title: 'Days until the tightest mount is full',
      unit: ' days',
      items: soon.slice(0, 12).map((r) => ({
        label: `${r.name} ${r.mount || ''}`,
        value: Math.round(r.days * 10) / 10,
        max: Math.max(60, ...soon.map((x) => x.days)),
        tone: r.days < 7 ? 'crit' : r.days < 30 ? 'warn' : 'ok',
      })),
    } : null,
    table: {
      title: 'Disk and memory trend, 7-day fit',
      cols: ['Server', 'Mount', 'Used', 'Free', 'Disk trend', 'Days to full', 'RAM', 'RAM trend'],
      rows: rows.map((r) => [
        r.name, r.mount || '—', r.used_pct === null ? '—' : `${r.used_pct}%`, gb(r.avail_kb),
        r.disk_slope === null ? '—' : `${r.disk_slope > 0 ? '+' : ''}${r.disk_slope}%/d`,
        r.days === null ? 'not shrinking' : `${r.days.toFixed(1)}`,
        r.ram === null ? '—' : `${r.ram}%`,
        r.ram_slope === null ? '—' : `${r.ram_slope > 0 ? '+' : ''}${r.ram_slope}%/d`,
      ]),
    },
    facts: rows.slice(0, 20).map((r) => `${r.name} ${r.mount || ''}: ${r.used_pct}% used, ${gb(r.avail_kb)} free, `
      + `trend ${r.disk_slope}%/day, ${r.days === null ? 'not shrinking' : `full in ~${r.days.toFixed(1)} days`}; `
      + `ram ${r.ram}% trend ${r.ram_slope}%/day`).join('\n'),
  };
}

async function datasetNdb(snap) {
  const hosts = snap.list.filter((s) => s.ndb?.present && s.ndb?.accessible !== false);
  const clusters = hosts.map((s) => ({ from: s.name, ndb: s.ndb }));
  // Several SQL nodes in one cluster all report the same topology; the fullest
  // view wins rather than drawing the same cluster once per reporting host.
  const best = clusters.sort((a, b) =>
    (b.ndb.nodes?.length || 0) - (a.ndb.nodes?.length || 0))[0] || null;

  return {
    kind: 'ndb_topology',
    title: 'MySQL NDB cluster topology',
    subtitle: best
      ? `${best.ndb.data_nodes_started}/${best.ndb.data_nodes_configured} data nodes started · seen from ${best.from}`
      : 'No host is reporting an NDB cluster',
    stats: best ? [
      { label: 'Data nodes', value: `${best.ndb.data_nodes_started}/${best.ndb.data_nodes_configured}`, tone: best.ndb.unhealthy ? 'crit' : 'ok' },
      { label: 'Node groups down', value: best.ndb.node_groups_known === false ? '?' : best.ndb.node_groups_down, tone: best.ndb.node_groups_down ? 'crit' : 'ok' },
      { label: 'Data memory', value: best.ndb.data_memory_pct != null ? `${n1(best.ndb.data_memory_pct)}%` : '—', tone: best.ndb.data_memory_pct > 85 ? 'crit' : 'ok' },
      { label: 'Index memory', value: best.ndb.index_memory_pct != null ? `${n1(best.ndb.index_memory_pct)}%` : '—' },
      { label: 'Arbitrator', value: best.ndb.arbitrator_connected === undefined ? '—' : (best.ndb.arbitrator_connected ? 'connected' : 'LOST'), tone: best.ndb.arbitrator_connected === false ? 'crit' : 'ok' },
    ] : [],
    topology: best?.ndb || null,
    reportedBy: clusters.map((c) => c.from),
    table: best ? {
      title: 'Nodes',
      cols: ['Node', 'Type', 'Host', 'Node group', 'Status', 'Uptime'],
      rows: (best.ndb.nodes || []).map((nd) => [
        `id ${nd.id}`, nd.type, nd.host || '—',
        nd.group === undefined ? '—' : String(nd.group),
        nd.status,
        nd.uptime_s ? `${(nd.uptime_s / 3600).toFixed(1)} h` : '—',
      ]),
    } : null,
    facts: best
      ? `${ndbSummary(best.ndb)}\nReported by: ${clusters.map((c) => c.from).join(', ')}`
      : 'No NDB cluster is visible. The agent collects NDB only when MONIT_NDB=1 and either ndbinfo (via mysql) or ndb_mgm is reachable on that host.',
  };
}

export async function buildDataset(kind, params = {}, snapIn = null) {
  const snap = snapIn || await fleetSnapshot();
  switch (kind) {
    case 'critical': return datasetCritical(snap);
    case 'capacity': return datasetCapacity(snap);
    case 'ndb_topology': return datasetNdb(snap);
    case 'fleet_health':
    default: return datasetFleetHealth(snap);
  }
}

// ---------------------------------------------------------------------------
// narrative
// ---------------------------------------------------------------------------

const NARRATIVE_SCHEMA = {
  type: 'object',
  properties: {
    executive_summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
          headline: { type: 'string' },
          analysis: { type: 'string' },
          recommendation: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['severity', 'headline', 'analysis', 'recommendation', 'confidence'],
      },
    },
    next_actions: { type: 'array', items: { type: 'string' } },
  },
  required: ['executive_summary', 'findings', 'next_actions'],
};

export async function narrate(dataset, { lang = 'th', log } = {}) {
  const messages = [
    {
      role: 'system',
      content: `You are an SRE writing the interpretation section of an infrastructure report.
You are given figures that are already computed and correct. Do NOT recompute them and do NOT invent any figure that is not below.
${lang === 'th'
    ? 'LANGUAGE: write every string value in Thai (ภาษาไทย). headline, analysis, recommendation, executive_summary and next_actions must all be Thai sentences. Keep metric names, units, server names, commands and identifiers in their original Latin form. Do not write an English sentence anywhere.'
    : 'LANGUAGE: write every string value in English.'}
Each finding must cite the server and the number it is about. Recommend a concrete action, never "monitor the situation".
If the data shows nothing wrong, say so plainly and return a short findings list rather than manufacturing concerns.
Return JSON only.`,
    },
    {
      role: 'user',
      content: `Report: ${dataset.title}\n${dataset.subtitle}\n\nFigures:\n${dataset.facts}`,
    },
  ];
  try {
    const j = await llmJson({ messages, schema: NARRATIVE_SCHEMA, profile: 'report', log });
    if (j && typeof j.executive_summary === 'string') {
      return {
        executive_summary: j.executive_summary,
        findings: Array.isArray(j.findings) ? j.findings.slice(0, 10) : [],
        next_actions: Array.isArray(j.next_actions) ? j.next_actions.slice(0, 8) : [],
      };
    }
  } catch (e) {
    log?.warn(e, 'report narration failed');
  }
  // A report whose numbers are right and whose prose is missing is still a
  // useful report — much more useful than an error page. Said in the report's
  // own language, since this line is the first thing the reader sees.
  return {
    executive_summary: lang === 'th'
      ? '(ยังไม่มีบทวิเคราะห์จากโมเดล — ตัวเลข กราฟ และตารางด้านล่างครบถ้วน คำนวณจากฐานข้อมูลโดยตรง)'
      : '(AI narration unavailable — the figures below are complete and were computed directly from the database.)',
    findings: [],
    next_actions: [],
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function barsSvg(bars) {
  if (!bars?.items?.length) return '';
  const rowH = 26, padL = 168, padR = 56, w = 760;
  const h = bars.items.length * rowH + 14;
  const inner = w - padL - padR;
  const parts = bars.items.map((it, i) => {
    const y = i * rowH + 6;
    const frac = Math.max(0, Math.min(1, Number(it.value) / Number(it.max || 100)));
    const bw = Math.max(2, inner * frac);
    return `<text class="bl" x="${padL - 10}" y="${y + 13}" text-anchor="end">${esc(it.label)}</text>`
      + `<rect class="bt" x="${padL}" y="${y + 3}" width="${inner}" height="14" rx="2"/>`
      + `<rect class="bf ${it.tone || 'ok'}" x="${padL}" y="${y + 3}" width="${bw.toFixed(1)}" height="14" rx="2"/>`
      + `<text class="bv" x="${padL + inner + 8}" y="${y + 13}">${esc(it.value)}${esc(bars.unit || '')}</text>`;
  });
  return `<div class="chart"><h3>${esc(bars.title)}</h3>`
    + `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(bars.title)}">${parts.join('')}</svg></div>`;
}

/**
 * NDB topology, drawn by node group.
 *
 * Laying the nodes out by group rather than by id is the whole point: the
 * question a topology picture has to answer is "how much redundancy is left in
 * each group", and an id-ordered list hides exactly that.
 */
function ndbSvg(ndb) {
  if (!ndb?.nodes?.length) return '';
  const nodes = ndb.nodes;
  const data = nodes.filter((n) => n.type === 'NDB');
  const mgm = nodes.filter((n) => n.type !== 'NDB');

  const groups = {};
  for (const nd of data) {
    const g = nd.group === undefined ? 'unknown' : String(nd.group);
    (groups[g] ||= []).push(nd);
  }
  const keys = Object.keys(groups).sort();
  const boxW = 168, boxH = 54, gap = 16, colGap = 26;
  const maxRows = Math.max(1, ...keys.map((k) => groups[k].length));
  const w = Math.max(680, keys.length * (boxW + colGap) + 40);
  const headerY = 84;
  const h = headerY + maxRows * (boxH + gap) + 46;

  const tone = (st) => (st === 'STARTED' ? 'ok' : st === 'STARTING' ? 'warn' : 'crit');

  let out = '';
  // management / API row
  const mgmW = Math.min(w - 40, Math.max(220, mgm.length * 150));
  out += `<rect class="grp" x="20" y="14" width="${mgmW}" height="52" rx="4"/>`
    + `<text class="gl" x="30" y="32">MANAGEMENT / API</text>`;
  mgm.slice(0, 6).forEach((nd, i) => {
    const x = 30 + i * 148;
    out += `<circle class="dot ${tone(nd.status)}" cx="${x + 6}" cy="${52}" r="5"/>`
      + `<text class="nn" x="${x + 18}" y="${56}">${esc(nd.type)} id${esc(nd.id)} ${esc(nd.host || '')}</text>`;
  });
  if (ndb.arbitrator_connected !== undefined) {
    out += `<text class="arb ${ndb.arbitrator_connected ? 'ok' : 'crit'}" x="${mgmW + 30}" y="46">`
      + `arbitrator ${ndb.arbitrator_connected ? 'connected' : 'LOST'}</text>`;
  }

  keys.forEach((k, ci) => {
    const x = 20 + ci * (boxW + colGap);
    const live = groups[k].filter((n) => n.status === 'STARTED').length;
    const total = groups[k].length;
    const risk = live === 0 ? 'crit' : (live === 1 && total > 1) ? 'warn' : 'ok';
    const gh = groups[k].length * (boxH + gap) + 34;
    out += `<rect class="grp ${risk}" x="${x}" y="${headerY - 26}" width="${boxW}" height="${gh}" rx="4"/>`
      + `<text class="gl" x="${x + 10}" y="${headerY - 8}">NODE GROUP ${esc(k)} — ${live}/${total} live</text>`;
    groups[k].forEach((nd, ri) => {
      const y = headerY + ri * (boxH + gap);
      out += `<rect class="node ${tone(nd.status)}" x="${x + 10}" y="${y}" width="${boxW - 20}" height="${boxH}" rx="3"/>`
        + `<text class="nid" x="${x + 20}" y="${y + 21}">node ${esc(nd.id)}</text>`
        + `<text class="nst ${tone(nd.status)}" x="${x + boxW - 20}" y="${y + 21}" text-anchor="end">${esc(nd.status)}</text>`
        + `<text class="nh" x="${x + 20}" y="${y + 39}">${esc(nd.host || 'host unknown')}</text>`;
      // Every data node connects to every management node; drawing all of those
      // lines is noise, so one stub per node points at the management band.
      out += `<line class="lnk" x1="${x + boxW / 2}" y1="${y}" x2="${x + boxW / 2}" y2="${y - 12}"/>`;
    });
    if (live === 1 && total > 1) {
      out += `<text class="warnlbl" x="${x + 10}" y="${headerY + total * (boxH + gap) - 2}">last survivor</text>`;
    }
    if (live === 0) {
      out += `<text class="critlbl" x="${x + 10}" y="${headerY + total * (boxH + gap) - 2}">group down — cluster offline</text>`;
    }
  });

  return `<div class="chart"><h3>Cluster layout by node group</h3>`
    + `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="NDB cluster topology">${out}</svg>`
    + `<p class="cap">Nodes are grouped by node group because that is what decides survival: a group with one live node is one failure from taking the whole cluster offline.</p></div>`;
}

function tableHtml(t) {
  if (!t?.rows?.length) return '';
  return `<div class="tbl"><h3>${esc(t.title)}</h3><div class="scroll"><table><thead><tr>`
    + t.cols.map((c) => `<th>${esc(c)}</th>`).join('')
    + '</tr></thead><tbody>'
    + t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table></div></div>';
}

export function renderHtml(dataset, narrative, meta = {}) {
  const when = new Date().toLocaleString('sv-SE', { timeZone: meta.tz || 'Asia/Bangkok' });
  const stats = (dataset.stats || []).map((s) =>
    `<div class="stat ${s.tone || ''}"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`).join('');

  const findings = (narrative.findings || []).map((f) => `
    <article class="finding ${esc(f.severity)}">
      <div class="fh"><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
        <h4>${esc(f.headline)}</h4>
        <span class="conf">confidence: ${esc(f.confidence)}</span></div>
      <p>${esc(f.analysis)}</p>
      <p class="rec"><strong>Action</strong> ${esc(f.recommendation)}</p>
      ${Array.isArray(f.evidence) && f.evidence.length
    ? `<p class="ev">evidence: ${f.evidence.map(esc).join(' · ')}</p>` : ''}
    </article>`).join('');

  const actions = (narrative.next_actions || []).length
    ? `<div class="tbl"><h3>Next actions</h3><ol class="acts">${narrative.next_actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol></div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(dataset.title)} — monit</title>
<style>
:root{color-scheme:light;--page:#f9f9f7;--surface:#fff;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--border:rgba(11,11,11,.12);--ok:#0ca30c;--warn:#c98500;--crit:#d03b3b;--accent:#2a78d6;--track:#e9e9e4}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;
--ink2:#c3c2b7;--muted:#898781;--border:rgba(255,255,255,.12);--ok:#3fb13f;--warn:#c98500;--crit:#e66767;
--accent:#3987e5;--track:#2c2c2a}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 72px}
header.rp{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:22px}
h1{font-size:23px;margin:0 0 4px}
.sub{color:var(--ink2);margin:0}
.meta{color:var(--muted);font-size:12px;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
h2{font-size:16px;margin:30px 0 10px}
h3{font-size:14px;margin:0 0 10px;color:var(--ink2)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin-bottom:24px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.stat .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .l{color:var(--ink2);font-size:12px;margin-top:2px}
.stat.ok .v{color:var(--ok)}.stat.warn .v{color:var(--warn)}.stat.crit .v{color:var(--crit)}
.stat.muted .v{color:var(--muted)}
.summary{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);
border-radius:0 10px 10px 0;padding:14px 16px;margin-bottom:24px}
.summary p{margin:0;white-space:pre-wrap}
.finding{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.finding.critical{border-left:3px solid var(--crit)}
.finding.warning{border-left:3px solid var(--warn)}
.finding.info{border-left:3px solid var(--accent)}
.fh{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.fh h4{margin:0;font-size:15px;flex:1 1 240px}
.sev{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:999px;font-weight:700}
.sev.critical{background:color-mix(in oklab,var(--crit) 16%,transparent);color:var(--crit)}
.sev.warning{background:color-mix(in oklab,var(--warn) 18%,transparent);color:var(--warn)}
.sev.info{background:color-mix(in oklab,var(--accent) 16%,transparent);color:var(--accent)}
.conf{font-size:11px;color:var(--muted)}
.finding p{margin:6px 0 0;white-space:pre-wrap}
.rec{color:var(--ink2)}
.ev{font-size:11.5px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.chart,.tbl{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:14px 0}
.chart svg{width:100%;height:auto;display:block}
.cap{font-size:12px;color:var(--muted);margin:10px 0 0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:520px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tbody tr:last-child td{border-bottom:0}
td{font-variant-numeric:tabular-nums}
.acts{margin:0;padding-left:20px}.acts li{margin:4px 0}
text{font-family:system-ui,-apple-system,sans-serif}
.bl{font-size:12px;fill:var(--ink2)}
.bv{font-size:12px;fill:var(--ink2);font-variant-numeric:tabular-nums}
.bt{fill:var(--track)}
.bf.ok{fill:var(--ok)}.bf.warn{fill:var(--warn)}.bf.crit{fill:var(--crit)}
.grp{fill:none;stroke:var(--border);stroke-width:1}
.grp.warn{stroke:var(--warn)}.grp.crit{stroke:var(--crit)}
.gl{font-size:10.5px;fill:var(--muted);letter-spacing:.06em}
.node{fill:var(--page);stroke:var(--border);stroke-width:1}
.node.ok{stroke:var(--ok)}.node.warn{stroke:var(--warn)}.node.crit{stroke:var(--crit)}
.nid{font-size:12.5px;fill:var(--ink);font-weight:600}
.nh{font-size:11px;fill:var(--muted)}
.nst{font-size:10.5px;font-weight:700}
.nst.ok{fill:var(--ok)}.nst.warn{fill:var(--warn)}.nst.crit{fill:var(--crit)}
.dot.ok{fill:var(--ok)}.dot.warn{fill:var(--warn)}.dot.crit{fill:var(--crit)}
.nn{font-size:11.5px;fill:var(--ink2)}
.lnk{stroke:var(--border);stroke-width:1}
.arb{font-size:11.5px;font-weight:600}.arb.ok{fill:var(--ok)}.arb.crit{fill:var(--crit)}
.warnlbl{font-size:10.5px;fill:var(--warn);font-weight:600}
.critlbl{font-size:10.5px;fill:var(--crit);font-weight:600}
footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
</style></head><body><div class="wrap">
<header class="rp">
  <h1>${esc(dataset.title)}</h1>
  <p class="sub">${esc(dataset.subtitle || '')}</p>
  <p class="meta">generated ${esc(when)} · monit · figures computed in SQL, interpretation written by ${esc(meta.model || 'the local model')}</p>
</header>
<div class="stats">${stats}</div>
<div class="summary"><p>${esc(narrative.executive_summary)}</p></div>
${findings ? `<h2>Findings</h2>${findings}` : ''}
${dataset.topology ? ndbSvg(dataset.topology) : ''}
${dataset.bars ? barsSvg(dataset.bars) : ''}
${tableHtml(dataset.table)}
${actions}
<footer>Every figure in this report was computed directly from the monitoring database at generation time.
The narrative was written by a language model from those figures and may be wrong about causes; the numbers are not its opinion.</footer>
</div></body></html>`;
}

/**
 * Claim a row before doing any work.
 *
 * Generation runs a model call that takes a minute or more on a local GPU. When
 * that happened inside the request, the browser held an open POST for the whole
 * time with nothing to show, and anything slower than nginx's
 * proxy_read_timeout came back as a 504 — discarding, from the user's point of
 * view, a report the server had finished writing. Creating the row first gives
 * the page something to poll and makes a slow model merely slow.
 */
export async function createPendingReport({ kind, params = {}, user }) {
  const { rows } = await q(
    `INSERT INTO ai_reports (kind, title, params, html, status, created_by)
     VALUES ($1,$2,$3,'','pending',$4)
     RETURNING id, kind, title, status, created_at`,
    [kind, REPORT_KINDS[kind] || kind, params, user || null]);
  return rows[0];
}

/** Do the work and fill the row in. Marks it failed rather than throwing away why. */
export async function fillReport(id, { kind, params = {}, lang = 'th', log, snap }) {
  try {
    const dataset = await buildDataset(kind, params, snap);
    const narrative = await narrate(dataset, { lang, log });
    const html = renderHtml(dataset, narrative, { model: params.model });
    await q(
      `UPDATE ai_reports SET title=$2, dataset=$3, narrative=$4, html=$5, status='ready', error=NULL
        WHERE id=$1`,
      [id, dataset.title, dataset, narrative, html]);
    return { id, title: dataset.title, narrative };
  } catch (e) {
    log?.error(e, `report ${kind} failed`);
    // The row stays, carrying the reason. A report that failed silently and
    // vanished from the list is the worst of both worlds.
    await q(`UPDATE ai_reports SET status='failed', error=$2 WHERE id=$1`,
      [id, String(e.message).slice(0, 500)]).catch(() => {});
    throw e;
  }
}

/** Build, narrate, render and store one report, start to finish. */
export async function generateReport({ kind, params = {}, lang = 'th', user, log, snap }) {
  const row = await createPendingReport({ kind, params, user });
  const done = await fillReport(row.id, { kind, params, lang, log, snap });
  return { ...row, title: done.title, status: 'ready', narrative: done.narrative };
}
