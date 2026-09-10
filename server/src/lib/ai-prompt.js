// System prompts and question routing.
//
// Two ideas are doing the work here.
//
// The first is that the model is told *how this system defines things*. It has
// never seen monit, so it does not know that "offline" is a time-since-sample
// rule rather than a ping, that avail_kb is kilobytes, or that an NDB node
// group losing every node is the one condition that stops the cluster. Those
// facts are cheap to state and expensive to guess wrong.
//
// The second is that a question is routed before any context is assembled.
// Packing the whole fleet into every message was what pushed the conversation
// out of the context window; deciding first what the question is about means a
// question about one server carries one server.

import { fleetHeader, fleetLine, serverDetail, incidentLine } from './ai-analytics.js';

const DOMAIN = `## How this system defines things (do not guess these)
- health: offline = no sample for 3x the 10s interval; critical/warning = an open incident of that severity; online = recent sample, no open incident. "offline" means the agent stopped reporting, NOT that the machine is confirmed down.
- cpu.total is a percentage across all cores. load.1m must be read against load.cores: load/cores > 1.0 means the run queue is backing up. Comparing a raw load number between hosts with different core counts is meaningless.
- disk.used_pct in a per-mount list is that mount. The tightest mount is often /boot or /boot/efi, which are small by design and always near full — judge a machine by the whole-machine figure and by mounts that matter.
- avail_kb, free_kb, size_kb are KILOBYTES. mem_used_mb is megabytes.
- network counters are cumulative; rates shown to you are already differenced.
- an incident goes firing -> acknowledged -> resolved, and may be silenced or flapping. "flapping" means the rule crossed its threshold repeatedly, which is a badly tuned rule as often as it is a sick server.
- MySQL NDB Cluster: data is sharded across node groups and mirrored inside each group. Losing SOME nodes in a group is survivable; losing EVERY node in ANY ONE group stops the whole cluster. A group down to its last live node is one failure away from that. NDB holds data in memory, so data_memory near 100% means writes start failing even with every node up. Without a connected arbitrator a split brain cannot be resolved.
- p95 over 24h next to a current value tells you whether now is normal for this host. z is measured against the same hour of day over the past 7 days, so it already accounts for nightly batch windows; |z| > 3 is genuinely unusual.
- a disk-full projection is a straight-line fit over 7 days. It is a warning, not a promise, and it is worthless if something changed recently.`;

/**
 * The answering protocol.
 *
 * Rewritten to be about LENGTH first, because that is what went wrong. The
 * earlier version read as five numbered steps and the model dutifully wrote all
 * five as sections, then a confidence paragraph, then a summary of what it had
 * checked — a screenful for a question with a one-line answer. A local model
 * given a numbered procedure produces a numbered document.
 *
 * So the shape is fixed and small: the verdict, the evidence, one action. The
 * reasoning steps are still there, but as things to DO rather than headings to
 * write, and the budget is stated in lines because "be concise" is not a number.
 */
const PROTOCOL = `## Shape of the answer — follow this exactly
Line 1: the answer itself, in one sentence. No preamble, no restating the question, no "จากข้อมูลที่มี".
Then: the evidence — the numbers and server names that support it. Use a markdown table when comparing 3 or more servers on the same fields, otherwise 2-4 short bullets.
Then: one line starting with "ควรทำ:" — a single concrete next step (a command, a threshold, a service to restart). Not "เฝ้าดูต่อไป".
Last line: "ความมั่นใจ: สูง/ปานกลาง/ต่ำ" and, in the same line, what would make it certain.

## Length
- The whole answer must be under 15 lines. A simple question deserves 2-3.
- Never list what you checked, never explain your method, never write a section describing the data before answering.
- Do not repeat a number that is already in the table.
- If a question has several parts, answer the part that was asked and stop.

## Thinking
Think briefly. Decide the answer, then write it. Do not draft the reply inside your reasoning — you will run out of room before you write anything the user can see.

## Markdown tables
When you use a table, write it as real markdown with a separator row, or it will not render:

| เครื่อง | disk / | แนวโน้ม 7 วัน | เต็มใน |
|---|---|---|---|
| db-01 | 91% | +1.8%/วัน | 6.4 วัน |

## Rules you must not break
- Every claim cites a number that is present in the context or came back from a tool. If it is not there, say it is not there.
- Missing data is never good news. "No sample" means unknown, never healthy.
- Do not invent server names, incident ids, thresholds, file paths or log lines.
- If two sources disagree, say so in one line and name both numbers — do not silently pick one.
- Prefer a straight-line fit only when the data actually moved. A flat metric has no projection; say it is flat rather than reporting a huge number of days.`;

/**
 * The language rule.
 *
 * "Reply in the language the user wrote in" was not enough. Everything around
 * it — the domain notes, the protocol, the tool results, the metric names — is
 * English, and a model reading three thousand English tokens answers in English
 * however the question was phrased. So the language is decided server-side and
 * stated as an instruction, twice: once at the top where it frames the task,
 * once as the very last line, because the end of a long prompt is what a model
 * weighs most.
 */
function languageRule(lang) {
  if (lang === 'en') return 'LANGUAGE: write your entire reply in English.';
  return 'LANGUAGE: เขียนคำตอบทั้งหมดเป็นภาษาไทย — write your ENTIRE reply in Thai (ภาษาไทย). '
    + 'This is not optional and does not depend on what language the question was written in. '
    + 'Every sentence, heading, bullet, table header and label must be Thai. '
    + 'Keep only these unchanged: metric names (cpu.total, ram.used_pct), units (GB, %, ms), '
    + 'server names, incident ids, shell commands and file paths. '
    + 'Do not write an English sentence anywhere in the answer.';
}

/**
 * Two worked examples, carried in the system message rather than as extra
 * turns.
 *
 * Shape is easier to teach by demonstration than by instruction, especially at
 * this model size: the protocol above says "end with a concrete action", and
 * the example is what makes that actually happen. Kept as text rather than as
 * user/assistant turns so it cannot be mistaken for real history, and so it
 * survives any chat template.
 */
const FEWSHOT = `## Two worked examples — copy this length and this shape

Q: มี server กี่เครื่องที่ offline
A: 2 เครื่อง — **cache-02** (เงียบมา 3 ชม.) และ **build-01** (14 นาที)

ควรทำ: ssh เข้า cache-02 แล้วดู systemctl status monit-agent ก่อน เพราะเงียบนานกว่ามาก
ความมั่นใจ: สูง — แต่ "offline" คือ agent หยุดส่ง ไม่ได้แปลว่าเครื่องดับ ต้อง ping ยืนยัน

Q: วิเคราะห์แนวโน้ม disk 7 วัน เครื่องไหนจะเต็มก่อน
A: **db-01 จะเต็มก่อน อีกประมาณ 6.4 วัน** ส่วนเครื่องอื่นแบนราบ ไม่มีอันไหนโตจนน่ากังวล

| เครื่อง | disk / | แนวโน้ม 7 วัน | เต็มใน |
|---|---|---|---|
| db-01 | 91% (เหลือ 8.2GB) | +1.8%/วัน | 6.4 วัน |
| web-01 | 75% (เหลือ 117GB) | +0.2%/วัน | > 90 วัน |
| cache-02 | 40% | แบนราบ | ไม่มีแนวโน้มเต็ม |

ควรทำ: บน db-01 รัน du -xh --max-depth=2 / | sort -hr | head -20 หาตัวที่โตเร็วที่สุด
ความมั่นใจ: ปานกลาง — เส้นตรง 7 วันใช้ไม่ได้ถ้ามีอะไรเปลี่ยนเพิ่งเกิด เช็ค log rotation ด้วย`;

// ---------------------------------------------------------------------------
// token budgeting
// ---------------------------------------------------------------------------

/**
 * Rough token count, deliberately pessimistic.
 *
 * Thai runs about one token per one-and-a-bit characters on a Qwen tokenizer;
 * English about four characters per token. Counting them separately is crude
 * but it is the difference between a 40% error and a 200% one, and every
 * decision below is "does this still fit" — where guessing high is safe and
 * guessing low is a truncated prompt.
 */
export function estimateTokens(text) {
  const t = String(text || '');
  let ascii = 0;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.5 + (t.length - ascii) / 1.2);
}

/** Which metric families a question is about. Empty means "all of them". */
export function detectAspects(text) {
  const t = String(text).toLowerCase();
  const a = new Set();
  if (/disk|ดิสก์|พื้นที่|เต็ม|storage|mount|partition|ฮาร์ดดิสก์/.test(t)) a.add('disk');
  if (/ram|memory|หน่วยความจำ|เมมโมรี|swap/.test(t)) a.add('ram');
  if (/cpu|ซีพียู|โหลด|processor/.test(t)) { a.add('cpu'); a.add('load'); }
  if (/load|โหลด|saturat/.test(t)) a.add('load');
  if (/network|เน็ต|แบนด์วิดท์|traffic|rx|tx/.test(t)) a.add('net');
  if (/service|pm2|docker|container|โพรเซส|process|บริการ/.test(t)) a.add('svc');
  if (/ndb|cluster|คลัสเตอร์|mysql|node group/.test(t)) a.add('ndb');
  return a;
}

/**
 * The answer, computed in SQL, handed over as a conclusion.
 *
 * This is the single change that made a small model usable here. Given a fleet
 * and the question "which disk fills first", the model was ranking the servers
 * itself — inside its reasoning, in prose, one at a time, second-guessing the
 * ordering — and on a short context it ran out of room before writing anything
 * the user could see.
 *
 * But the ranking is not a judgement call. `daysToFull` is already computed for
 * every server, and sorting is what a database does. So the ordering is settled
 * here and stated as fact, and the model's remaining job is to say it in Thai
 * with a table and one recommendation: a job worth a couple of hundred tokens
 * instead of two thousand.
 */
export function computeLead(snap, { intent, aspects }) {
  const n1 = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
  const online = snap.list.filter((s) => s.health !== 'offline');
  const lines = [];

  if (aspects.has('disk') || intent === 'capacity') {
    const shrinking = online.filter((s) => s.daysToFull !== null)
      .sort((a, b) => a.daysToFull - b.daysToFull);
    const flat = online.filter((s) => s.daysToFull === null && s.worstDisk);
    if (shrinking.length) {
      lines.push('อันดับเครื่องที่จะเต็มก่อน (เรียงแล้ว อย่าจัดอันดับใหม่):');
      for (const s of shrinking.slice(0, 5)) {
        lines.push(`  ${s.name}: อีก ${s.daysToFull.toFixed(1)} วัน — ${s.capacity.mount} `
          + `${n1(s.worstDisk?.used_pct)}% เหลือ ${((Number(s.capacity.avail_now) || 0) / 1024 / 1024).toFixed(1)}GB`);
      }
    } else {
      lines.push('ไม่มีเครื่องใดมีแนวโน้มดิสก์เต็ม: การ fit เส้นตรง 7 วันไม่พบเครื่องที่พื้นที่ว่างลดลงจริง');
    }
    if (flat.length) {
      // Named, not counted: "the rest are flat" invites the model to go and
      // check what "the rest" means, which is another pass over the fleet.
      const worst = flat.sort((a, b) => Number(b.worstDisk.used_pct) - Number(a.worstDisk.used_pct))[0];
      lines.push(`เครื่องที่แนวโน้มแบนราบ: ${flat.length} เครื่อง `
        + `(ใช้พื้นที่สูงสุดคือ ${worst.name} ที่ ${n1(worst.worstDisk.used_pct)}% แต่ไม่โต)`);
      const tight = flat.filter((s) => Number(s.worstDisk.avail_kb) < 20 * 1024 * 1024);
      if (tight.length) {
        lines.push(`  แบนราบแต่พื้นที่เหลือน้อยกว่า 20GB: ${tight.map((s) => `${s.name} (${((Number(s.worstDisk.avail_kb)) / 1024 / 1024).toFixed(1)}GB)`).join(', ')}`);
      }
    }
  }

  if (aspects.has('ram')) {
    const rising = online.filter((s) => Number(s.trend?.ram_pct_per_day) > 0.3)
      .sort((a, b) => Number(b.trend.ram_pct_per_day) - Number(a.trend.ram_pct_per_day));
    lines.push(rising.length
      ? `RAM ที่ไต่ขึ้นจริง (เรียงตามอัตราการโต): ${rising.slice(0, 5).map((s) => `${s.name} ${n1(s.sample?.ram?.used_pct)}% +${n1(s.trend.ram_pct_per_day)}%/วัน`).join(', ')}`
      : 'RAM: ไม่มีเครื่องใดมีแนวโน้มไต่ขึ้นเกิน 0.3%/วัน');
  }

  if (aspects.has('cpu')) {
    const busy = online.filter((s) => Number(s.stats24?.cpu_p95) > 60)
      .sort((a, b) => Number(b.stats24.cpu_p95) - Number(a.stats24.cpu_p95));
    lines.push(busy.length
      ? `CPU สูงสุดตาม 24h p95: ${busy.slice(0, 5).map((s) => `${s.name} p95 ${n1(s.stats24.cpu_p95)}%`).join(', ')}`
      : 'CPU: ไม่มีเครื่องใดที่ 24h p95 เกิน 60%');
  }

  // Always: the things that are true regardless of what was asked.
  const off = snap.list.filter((s) => s.health === 'offline');
  if (off.length) lines.push(`ไม่ส่ง sample: ${off.map((s) => `${s.name} (${Math.round((Date.now() - new Date(s.last_seen).getTime()) / 60000)} นาที)`).join(', ')}`);
  const missing = online.filter((s) => s.missingServices.length);
  if (missing.length) lines.push(`service ที่ประกาศไว้แต่ไม่รัน: ${missing.map((s) => `${s.name}: ${s.missingServices.join(',')}`).join(' | ')}`);

  return lines.length ? lines.join('\n') : null;
}

/**
 * Assemble the system message, inside a token budget.
 *
 * The deployment this was written against serves a quantized 27B on two cards
 * with a context sized to fit, not to be generous. Everything here therefore
 * has a priority, and sections are dropped from the bottom up until the prompt
 * fits — an answer built on nine servers instead of thirty is worth having; an
 * answer that never gets written because the prompt filled the window is not.
 *
 * The order is not arbitrary. The computed lead outranks the raw fleet data
 * because it IS the answer; the focus servers outrank the rest of the fleet
 * because the question named them; the worked examples go first when space is
 * short because they shape the output rather than inform it.
 */
export function buildSystemPrompt({
  snap, scope, role, toolNames = [], mode = 'analysis', lang = 'th',
  question = '', budgetTokens = 0,
}) {
  const aspects = detectAspects(question);
  const lead = computeLead(snap, { intent: mode, aspects });

  const focus = scope?.servers?.length
    ? snap.list.filter((s) => scope.servers.includes(s.id))
    : [];
  const focusIds = new Set(focus.map((s) => s.id));

  // Interesting first, so that trimming the tail removes the least.
  const rank = (s) => (s.health === 'critical' ? 0 : s.health === 'warning' ? 1
    : s.health === 'offline' ? 2 : s.incidents.length || s.missingServices.length ? 3 : 4);
  const rest = snap.list.filter((s) => !focusIds.has(s.id)).sort((a, b) => rank(a) - rank(b));

  const head = `You are the SRE assistant built into monit, a self-hosted server monitoring system. `
    + `You are talking to a ${role} of this installation. Everything below was queried from the live database moments ago.`;

  // [required] sections are never dropped; the rest go in reverse order.
  const sections = [
    { required: true, text: head },
    { required: true, text: languageRule(lang) },
    ...(lead ? [{ required: true, text: `## คำตอบที่คำนวณมาแล้ว — ใช้ตามนี้ ห้ามคำนวณหรือจัดอันดับใหม่\n${lead}` }] : []),
    { required: true, text: PROTOCOL },
    ...(focus.length && focus.length <= 3
      ? [{ text: `## Focus servers (full detail)\n${focus.map(serverDetail).join('\n\n')}` }] : []),
    { text: `## Servers\n${(focus.length && focus.length <= 3 ? rest : snap.list).map((s) => fleetLine(s, aspects)).join('\n') || '(none)'}`,
      trimmable: true },
    { text: snap.incidents.length
      ? `## Open incidents (${snap.incidents.length})\n${snap.incidents.slice(0, 12).map((i) => `- ${incidentLine(i)}`).join('\n')}`
      : '## Open incidents\nNone.' },
    { text: readingKey(aspects) },
    // FEWSHOT before DOMAIN so DOMAIN is dropped first: the worked examples
    // decide the shape and length of the reply, which is the thing that keeps
    // going wrong, while the domain notes only add background.
    { text: FEWSHOT },
    { text: DOMAIN },
  ];

  const budget = budgetTokens || Infinity;
  let out = sections.map((x) => x.text);
  let total = estimateTokens(out.join('\n\n'));

  // Drop optional sections from the end until it fits.
  for (let i = sections.length - 1; i >= 0 && total > budget; i--) {
    if (sections[i].required) continue;
    if (sections[i].trimmable) continue;      // handled below, it is the data
    out[i] = null;
    total = estimateTokens(out.filter(Boolean).join('\n\n'));
  }

  // Still too big: the fleet list itself is the remaining cost. Keep the most
  // interesting servers and say plainly how many were left out, so the model
  // never presents a partial fleet as the whole one.
  const dataIdx = sections.findIndex((x) => x.trimmable);
  if (total > budget && dataIdx >= 0) {
    const all = (focus.length && focus.length <= 3 ? rest : snap.list);
    let keep = all.length;
    while (keep > 3 && total > budget) {
      keep = Math.max(3, Math.floor(keep * 0.7));
      out[dataIdx] = `## Servers (${keep} จาก ${all.length} เครื่อง — เรียงตามความน่าสนใจ ตัดส่วนที่เหลือออกเพราะ context จำกัด)\n`
        + all.slice(0, keep).map((s) => fleetLine(s, aspects)).join('\n')
        + (keep < all.length ? `\n(อีก ${all.length - keep} เครื่องไม่ได้แสดง — ถ้าคำถามต้องใช้ ให้บอกผู้ใช้ว่ายังไม่ได้ดูครบ)` : '');
      total = estimateTokens(out.filter(Boolean).join('\n\n'));
    }
  }

  const text = out.filter(Boolean).join('\n\n');
  return { text, tokens: estimateTokens(text), aspects: [...aspects], lead: !!lead };
}

/** Only explains the shorthand that is actually on screen. */
function readingKey(aspects) {
  const want = (k) => !aspects.size || aspects.has(k);
  const rows = ['## Reading the server lines'];
  if (want('cpu') || want('ram')) rows.push('"cpu 82.1%(24h p95 88) +2.1/d" = now, the 95th percentile over 24h, the 7-day trend per day.');
  if (want('disk')) rows.push('"disk / 91% avail 8.2GB (machine 74%) FULL~6.4d" = fullest real filesystem, space left, whole machine, straight-line projection. "(แบนราบ)" = not shrinking, so no projection exists. Partitions under 4GB are excluded.');
  if (want('load')) rows.push('"load 0.99/core" = load average divided by core count.');
  rows.push('"ANOM ram z=3.4" = far outside this host\'s own normal for this hour. "MISSING docker[redis]" = declared as expected but not running.');
  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Intent keywords.
 *
 * Split into ASCII and Thai halves for one reason: \b in JavaScript is defined
 * against [A-Za-z0-9_], so \bเต็ม\b can never match — the characters on both
 * sides of a Thai word are not word characters, so there is no boundary there
 * to find. Written as one alternation with \b it silently matched nothing
 * Thai, and every Thai question fell through to the default intent. The ASCII
 * terms still want \b, because "report" should not fire on "reported".
 */
const RE = {
  report: [/\b(report|export)\b/i, /(รายงาน|ออกรายงาน|สรุปเป็นเอกสาร)/],
  topology: [/\b(topolog\w*|ndb|cluster|node ?group)\b/i, /(คลัสเตอร์|แผนผัง|ผังการเชื่อม|โทโพโลยี)/],
  capacity: [/\b(capacity|forecast|disk ?full|trend)\b/i, /(จะเต็ม|เต็มเมื่อ|พื้นที่เหลือ|คาดการณ์|แนวโน้ม|โตขึ้น|พยากรณ์)/],
  analyze: [/\b(why|analy\w+|root cause|anomal\w*|correlat\w*|compare|recommend|tune|risk)\b/i,
    /(ทำไม|วิเคราะห์|สาเหตุ|เกิดอะไร|ผิดปกติ|เปรียบเทียบ|สัมพันธ์|ควรทำ|แนะนำ|ปรับ|เสี่ยง|ตรวจสอบ)/],
  lookup: [/\b(how many|list|show|what is|which)\b/i, /(กี่|จำนวน|แสดง|รายชื่อ|มีอะไรบ้าง|ชื่อ)/],
};

const hits = (key, t) => RE[key].some((r) => r.test(t));
/**
 * Classify a question and pull out which servers it names.
 *
 * Keywords first, because they are free and right most of the time. The point
 * is not perfect classification — it is not spending the whole context window
 * on a question that turned out to be "how many servers are there".
 */
export function routeIntent(text, snap) {
  const t = String(text || '');
  const servers = [];
  for (const s of snap.list) {
    const name = s.name.toLowerCase();
    // Two characters is not a server reference, it is a coincidence.
    if (name.length >= 3 && t.toLowerCase().includes(name)) servers.push(s.id);
  }

  // Order matters: "ขอรายงาน ndb cluster" is a report about topology, not a
  // topology question, so report is tested first.
  let intent;
  if (hits('report', t)) intent = 'report';
  else if (hits('analyze', t)) intent = 'analyze';
  else if (hits('topology', t)) intent = 'topology';
  else if (hits('capacity', t)) intent = 'capacity';
  else if (hits('lookup', t)) intent = 'lookup';
  else intent = 'analyze';

  // A lookup that names one server is really a drill-down, and the extra
  // detail costs almost nothing once the server is already chosen.
  if (intent === 'lookup' && servers.length === 1) intent = 'analyze';

  return {
    intent,
    servers,
    // Only a lookup is confident enough to skip the tool phase: everything
    // else benefits from the model being able to go and look.
    useTools: intent !== 'lookup',
    profile: intent === 'lookup' ? 'lookup' : 'analysis',
  };
}

/** The instruction for the planning turn — deciding what to look up, not answering. */
export const PLAN_INSTRUCTION = `Decide what extra data you need to answer well, and call the tools to get it.
- Call a tool only when the answer is not already in the context above.
- You may call several tools in one turn.
- Do NOT write the answer yet. If you already have everything you need, reply with exactly: READY`;
