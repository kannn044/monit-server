// Deterministic analytics for the AI chat: everything numeric is computed in
// SQL, and the model only ever reads the conclusions.
//
// This is the single most important idea in the AI feature. A local 8B-class
// model asked to derive a 95th percentile, a trend, or "how many days until
// this disk is full" from a list of raw samples gets it wrong often enough to
// be worse than useless — and it gets it wrong *confidently*. Postgres gets it
// right every time, so the split is: SQL produces the numbers, the model
// produces the explanation.
//
// The output of this module is plain text on purpose. Deeply nested JSON in a
// prompt costs tokens in punctuation and reads worse to a small model than one
// dense line per server.

import { q } from '../db/pool.js';
import { computeHealth } from './health.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

const n1 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

function kb(v) {
  if (v === null || v === undefined) return '?';
  const x = Number(v);
  if (x >= 1024 * 1024) return `${(x / 1024 / 1024).toFixed(1)}GB`;
  if (x >= 1024) return `${(x / 1024).toFixed(0)}MB`;
  return `${x}KB`;
}

function bps(v) {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  if (x >= 1024 * 1024) return `${(x / 1024 / 1024).toFixed(1)}MB/s`;
  if (x >= 1024) return `${(x / 1024).toFixed(0)}KB/s`;
  return `${Math.round(x)}B/s`;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Signed per-day trend, printed only when it is big enough to mean anything. */
function slopeTag(perDay, unit = '') {
  const v = n1(perDay);
  if (v === null || Math.abs(v) < 0.3) return '';
  return ` ${v > 0 ? '+' : ''}${v}${unit}/d`;
}

// ---------------------------------------------------------------------------
// the queries
// ---------------------------------------------------------------------------

const SERVERS_SQL = `
  SELECT s.id, s.name, host(s.ip) AS ip, s.os, s.last_seen,
         COALESCE((SELECT array_agg(DISTINCT i.severity) FROM incidents i
                    WHERE i.server_id = s.id AND i.status IN ('firing','acknowledged')), '{}')
           AS active_severities,
         COALESCE((SELECT array_agg(p.name) FROM server_projects sp
                     JOIN projects p ON p.id = sp.project_id
                    WHERE sp.server_id = s.id), '{}') AS groups
    FROM servers s
   WHERE s.archived_at IS NULL
   ORDER BY s.name`;

/**
 * Latest raw sample per server.
 *
 * The time bound is not an optimisation, it is what makes the query usable:
 * without it DISTINCT ON walks every chunk of the hypertable back to the start
 * of retention on every chat message. A server with nothing in the window is
 * offline anyway, and computeHealth() already says so.
 */
const LATEST_SQL = `
  SELECT DISTINCT ON (server_id)
         server_id, time, cpu, ram, load, uptime_s, disk, network, gpu, docker, pm2, http, databases
    FROM system_metrics
   WHERE time > now() - ($1::int * interval '1 second')
   ORDER BY server_id, time DESC`;

/** Percentiles and averages over a window, from the hourly rollup. */
function windowStatsSql(interval) {
  return `
    SELECT server_id,
           avg(cpu_total_pct)                                                    AS cpu_avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_total_pct)           AS cpu_p95,
           max(cpu_max_pct)                                                      AS cpu_max,
           avg(ram_used_pct)                                                     AS ram_avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ram_used_pct)            AS ram_p95,
           avg(disk_used_pct)                                                    AS disk_avg,
           min(disk_avail_kb)                                                    AS disk_avail_min,
           avg(load_1m)                                                          AS load_avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY load_1m)                 AS load_p95,
           max(cores)                                                            AS cores,
           avg(gpu_util_pct)                                                     AS gpu_util_avg,
           max(gpu_mem_used_pct)                                                 AS gpu_mem_max,
           count(*)                                                              AS buckets
      FROM metrics_1h
     WHERE bucket > now() - interval '${interval}'
     GROUP BY server_id`;
}

/**
 * Linear trend over 7 days, plus the disk-full projection derived from it.
 *
 * regr_slope() ships with Postgres, so "will this fill up, and when" needs no
 * extension and no library — and being a closed form it cannot drift the way a
 * model's arithmetic does. Only a *falling* avail slope yields an ETA; a disk
 * that is emptying gets no scary countdown.
 */
const TREND_SQL = `
  WITH h AS (
    SELECT server_id, extract(epoch FROM bucket) AS t,
           ram_used_pct, disk_used_pct, disk_avail_kb, cpu_total_pct
      FROM metrics_1h
     WHERE bucket > now() - interval '7 days'
  )
  SELECT server_id,
         regr_slope(ram_used_pct,  t) * 86400 AS ram_pct_per_day,
         regr_slope(disk_used_pct, t) * 86400 AS disk_pct_per_day,
         regr_slope(cpu_total_pct, t) * 86400 AS cpu_pct_per_day,
         regr_slope(disk_avail_kb, t)         AS avail_kb_per_sec,
         count(*)                             AS buckets
    FROM h GROUP BY server_id`;

/**
 * Baseline for the same hour of day over the past week.
 *
 * Comparing "now" against a flat weekly average fires on every host that has a
 * nightly backup window. Comparing it against the same hour on other days is
 * the cheapest way to keep daily seasonality from reading as an anomaly.
 */
const BASELINE_SQL = `
  SELECT server_id,
         avg(cpu_total_pct)        AS cpu_mean,  stddev_pop(cpu_total_pct) AS cpu_sd,
         avg(ram_used_pct)         AS ram_mean,  stddev_pop(ram_used_pct)  AS ram_sd
    FROM metrics_1h
   WHERE bucket > now() - interval '7 days'
     AND bucket < date_trunc('hour', now())
     AND extract(hour FROM bucket) = extract(hour FROM now())
   GROUP BY server_id`;

/** Network rate from consecutive 1-minute buckets; a counter reset yields null. */
const NET_SQL = `
  WITH w AS (
    SELECT server_id, bucket, net_rx_bytes, net_tx_bytes
      FROM metrics_1m
     WHERE bucket > now() - interval '15 minutes'
  ), b AS (
    SELECT server_id,
           max(net_rx_bytes) - min(net_rx_bytes) AS rx_d,
           max(net_tx_bytes) - min(net_tx_bytes) AS tx_d,
           extract(epoch FROM (max(bucket) - min(bucket))) AS secs
      FROM w GROUP BY server_id
  )
  SELECT server_id,
         CASE WHEN secs > 0 AND rx_d >= 0 THEN rx_d / secs END AS rx_bps,
         CASE WHEN secs > 0 AND tx_d >= 0 THEN tx_d / secs END AS tx_bps
    FROM b`;

/**
 * Per-mount disk trend, and the projection that comes out of it.
 *
 * This cannot come from metrics_1h: that rollup stores min(avail) across every
 * mount, and on almost every host the smallest mount is /boot — 900MB, 90%
 * full by design, and never changing. Fitting a line to that reports "not
 * shrinking" for a machine whose root filesystem is filling steadily, which is
 * the exact question a capacity forecast exists to answer.
 *
 * So it goes back to the raw samples, but takes one row per hour before
 * expanding the jsonb, and ignores anything under 4 GiB — small enough to be a
 * boot or EFI partition, large enough to keep every real filesystem.
 */
const DISK_TREND_SQL = `
  WITH hourly AS (
    SELECT DISTINCT ON (server_id, date_trunc('hour', time))
           server_id, date_trunc('hour', time) AS b, disk
      FROM system_metrics
     WHERE time > now() - interval '7 days'
     ORDER BY server_id, date_trunc('hour', time), time DESC
  ), mounts AS (
    SELECT server_id, b,
           d->>'mount'              AS mount,
           (d->>'size_kb')::bigint  AS size_kb,
           (d->>'avail_kb')::bigint AS avail_kb,
           (d->>'used_pct')::double precision AS used_pct
      FROM hourly, LATERAL jsonb_array_elements(COALESCE(disk, '[]'::jsonb)) d
  ), fitted AS (
    SELECT server_id, mount,
           max(size_kb)                                AS size_kb,
           count(*)                                    AS buckets,
           regr_slope(avail_kb, extract(epoch FROM b)) AS kb_per_sec,
           (array_agg(avail_kb ORDER BY b DESC))[1]    AS avail_now,
           (array_agg(used_pct ORDER BY b DESC))[1]    AS used_pct
      FROM mounts
     WHERE size_kb > 4 * 1024 * 1024
     GROUP BY server_id, mount
  )
  SELECT DISTINCT ON (server_id)
         server_id, mount, size_kb, buckets, kb_per_sec, avail_now, used_pct,
         CASE WHEN kb_per_sec < 0 AND buckets >= 12
              THEN avail_now / (-kb_per_sec) / 86400 END AS days_to_full
    FROM fitted
   ORDER BY server_id,
            COALESCE(CASE WHEN kb_per_sec < 0 AND buckets >= 12
                          THEN avail_now / (-kb_per_sec) END, 1e18) ASC,
            used_pct DESC`;

/**
 * Cached for five minutes.
 *
 * It is the one query here that reads raw samples over a week, and a seven-day
 * trend does not move between two messages typed a minute apart. Paying for it
 * on every chat turn would be paying for nothing.
 */
let diskTrendCache = { at: 0, map: {} };
async function diskTrend() {
  if (Date.now() - diskTrendCache.at < 5 * 60_000) return diskTrendCache.map;
  const { rows } = await q(DISK_TREND_SQL);
  diskTrendCache = { at: Date.now(), map: byServer(rows) };
  return diskTrendCache.map;
}

const INCIDENTS_SQL = `
  SELECT i.id, i.server_id, i.severity, i.status, i.rule_name, i.metric,
         r.comparator, i.threshold, i.value, i.message, i.started_at
    FROM incidents i
    LEFT JOIN alert_rules r ON r.id = i.rule_id
   WHERE i.status IN ('firing','acknowledged')
   ORDER BY (i.severity = 'critical') DESC, i.started_at DESC
   LIMIT 60`;

const EXPECTED_SQL = `SELECT server_id, kind, name, enabled FROM expected_services WHERE enabled`;

// ---------------------------------------------------------------------------
// snapshot assembly
// ---------------------------------------------------------------------------

const byServer = (rows) => Object.fromEntries(rows.map((r) => [r.server_id, r]));

/**
 * One round trip's worth of everything the chat could need about the fleet.
 * Every caller in the AI feature builds on this, so it runs exactly once per
 * request no matter how many tools the model ends up calling.
 */
export async function fleetSnapshot() {
  const staleS = config.sampleIntervalS * config.offlineFactor * 2;
  const [
    { rows: servers }, { rows: latest }, { rows: s24 }, { rows: s7d },
    { rows: trend }, { rows: base }, { rows: net }, { rows: incidents }, { rows: expected },
    diskCap,
  ] = await Promise.all([
    q(SERVERS_SQL),
    q(LATEST_SQL, [staleS]),
    q(windowStatsSql('24 hours')),
    q(windowStatsSql('7 days')),
    q(TREND_SQL),
    q(BASELINE_SQL),
    q(NET_SQL),
    q(INCIDENTS_SQL),
    q(EXPECTED_SQL),
    diskTrend(),
  ]);

  const L = byServer(latest), A = byServer(s24), B = byServer(s7d);
  const T = byServer(trend), Z = byServer(base), N = byServer(net);
  const D = diskCap;

  const expectedBy = {};
  for (const e of expected) (expectedBy[e.server_id] ||= []).push(e);

  const incidentsBy = {};
  for (const i of incidents) (incidentsBy[i.server_id] ||= []).push(i);

  const list = servers.map((s) => {
    const sample = L[s.id] || null;
    const health = computeHealth({ last_seen: s.last_seen, activeSeverities: s.active_severities });
    const disks = Array.isArray(sample?.disk) ? sample.disk : [];
    // Judging a machine by its tightest mount reports /boot on nearly every
    // host — small by design, permanently near full, and never the answer to
    // "is this box running out of space". Real filesystems first; fall back to
    // whatever exists only when there is nothing bigger.
    const pick = (xs) => (xs.length ? xs.reduce((a, b) => (Number(b.used_pct) > Number(a.used_pct) ? b : a)) : null);
    const bigDisks = disks.filter((d) => Number(d.size_kb) > 4 * 1024 * 1024);
    const tightestDisk = pick(disks);
    const worstBig = pick(bigDisks) || tightestDisk;

    let diskTotalPct = null;
    let size = 0, used = 0;
    for (const d of disks) {
      const sz = Number(d.size_kb), us = Number(d.used_kb);
      if (sz > 0 && Number.isFinite(us)) { size += sz; used += us; }
    }
    if (size > 0) diskTotalPct = (100 * used) / size;

    const tr = T[s.id] || {};
    // The projection comes from the per-mount fit, which has already refused to
    // answer when the slope is flat or there were too few buckets to fit one.
    const cap = D[s.id] || null;
    const daysToFull = cap?.days_to_full != null ? Number(cap.days_to_full) : null;
    // Prefer the live reading for the mount the fit chose — the fit's own
    // "now" is up to an hour old.
    const capMount = cap ? disks.find((d) => d.mount === cap.mount) : null;

    const z = (val, mean, sd) => {
      const v = Number(val), m = Number(mean), d = Number(sd);
      if (!Number.isFinite(v) || !Number.isFinite(m) || !Number.isFinite(d) || d < 1) return null;
      return (v - m) / d;
    };
    const zb = Z[s.id] || {};

    const missing = [];
    for (const e of expectedBy[s.id] || []) {
      const listOf = e.kind === 'pm2' ? sample?.pm2?.processes : sample?.docker?.containers;
      if (!Array.isArray(listOf)) continue;                 // collector unavailable — not a verdict
      const found = listOf.find((x) => (x.name || x.names) === e.name);
      const ok = e.kind === 'pm2'
        ? found?.status === 'online'
        : /running|up/i.test(String(found?.state || found?.status || ''));
      if (!ok) missing.push(`${e.kind}[${e.name}]`);
    }

    return {
      id: s.id,
      name: s.name,
      ip: s.ip,
      os: s.os,
      groups: s.groups || [],
      health,
      last_seen: s.last_seen,
      sample,
      disks,
      worstDisk: capMount || worstBig,
      tightestDisk,
      capacity: cap,
      diskTotalPct,
      stats24: A[s.id] || null,
      stats7d: B[s.id] || null,
      trend: tr,
      net: N[s.id] || null,
      daysToFull,
      cpuZ: z(sample?.cpu?.total, zb.cpu_mean, zb.cpu_sd),
      ramZ: z(sample?.ram?.used_pct, zb.ram_mean, zb.ram_sd),
      incidents: incidentsBy[s.id] || [],
      expected: expectedBy[s.id] || [],
      missingServices: missing,
      ndb: sample?.databases?.ndb || null,
    };
  });

  const totals = {
    servers: list.length,
    online: list.filter((s) => s.health === 'online').length,
    warning: list.filter((s) => s.health === 'warning').length,
    critical: list.filter((s) => s.health === 'critical').length,
    offline: list.filter((s) => s.health === 'offline').length,
    incidents: incidents.length,
    pm2: list.reduce((a, s) => a + (Number(s.sample?.pm2?.online) || 0), 0),
    docker: list.reduce((a, s) => a + (Number(s.sample?.docker?.running) || 0), 0),
  };

  return { list, byId: Object.fromEntries(list.map((s) => [s.id, s])), totals, incidents };
}

// ---------------------------------------------------------------------------
// rendering for the prompt
// ---------------------------------------------------------------------------

/** One dense line per server — what the model sees for a fleet-wide question. */
export function fleetLine(s) {
  const p = [];
  const cpu = n1(s.sample?.cpu?.total);
  const ram = n1(s.sample?.ram?.used_pct);
  const a24 = s.stats24 || {};

  p.push(`- ${s.name} [${s.health}]`);
  if (s.health === 'offline') {
    p.push(`last sample ${ago(s.last_seen)} ago`);
    return p.join(' ');
  }
  if (cpu !== null) p.push(`cpu ${cpu}%${a24.cpu_p95 ? `(24h p95 ${n1(a24.cpu_p95)})` : ''}${slopeTag(s.trend?.cpu_pct_per_day)}`);
  if (ram !== null) p.push(`ram ${ram}%${a24.ram_p95 ? `(24h p95 ${n1(a24.ram_p95)})` : ''}${slopeTag(s.trend?.ram_pct_per_day)}`);
  if (s.worstDisk) {
    let d = `disk ${s.worstDisk.mount} ${n1(s.worstDisk.used_pct)}% avail ${kb(s.worstDisk.avail_kb)}`;
    if (s.diskTotalPct !== null) d += ` (machine ${n1(s.diskTotalPct)}%)`;
    if (s.daysToFull !== null && s.daysToFull < 90) d += ` FULL~${s.daysToFull.toFixed(1)}d`;
    p.push(d);
    // A small partition at 99% is not a capacity story, but a full /boot does
    // break the next kernel upgrade, so it is worth one short clause.
    if (s.tightestDisk && s.tightestDisk.mount !== s.worstDisk.mount
        && Number(s.tightestDisk.used_pct) >= 95) {
      p.push(`small mount ${s.tightestDisk.mount} ${n1(s.tightestDisk.used_pct)}%`);
    }
  }
  const cores = Number(a24.cores) || Number(s.sample?.load?.cores);
  const l1 = Number(s.sample?.load?.['1m']);
  if (Number.isFinite(l1) && cores > 0) p.push(`load ${n1(l1 / cores)}/core`);
  if (s.sample?.pm2?.accessible !== false && s.sample?.pm2?.present) {
    p.push(`pm2 ${s.sample.pm2.online}on/${(s.sample.pm2.online || 0) + (s.sample.pm2.stopped || 0)}`);
  }
  if (s.sample?.docker?.accessible !== false && s.sample?.docker?.present) {
    p.push(`docker ${s.sample.docker.running}/${s.sample.docker.total}`);
  }
  if (s.ndb?.accessible) {
    p.push(`ndb ${s.ndb.data_nodes_started}/${s.ndb.data_nodes_configured}nodes`
      + (s.ndb.data_memory_pct != null ? ` mem ${n1(s.ndb.data_memory_pct)}%` : ''));
  }
  if (Math.abs(s.cpuZ ?? 0) >= 2.5) p.push(`ANOM cpu z=${n1(s.cpuZ)}`);
  if (Math.abs(s.ramZ ?? 0) >= 2.5) p.push(`ANOM ram z=${n1(s.ramZ)}`);
  if (s.missingServices.length) p.push(`MISSING ${s.missingServices.join(',')}`);
  if (s.incidents.length) p.push(`inc ${s.incidents.length}`);
  return p.join(' · ');
}

/** Everything known about one server — what a drill-down question gets. */
export function serverDetail(s) {
  if (!s) return '(unknown server)';
  const out = [];
  const a = s.stats24 || {}, w = s.stats7d || {};
  out.push(`### ${s.name} (id=${s.id})`);
  out.push(`ip=${s.ip || 'n/a'} os=${s.os || 'n/a'} groups=${s.groups.join(',') || 'none'} `
    + `health=${s.health} last_sample=${ago(s.last_seen)} ago`);
  if (s.health === 'offline') {
    out.push('No recent samples — the agent is not reporting. Nothing below is current.');
    return out.join('\n');
  }
  const up = Number(s.sample?.uptime_s);
  if (Number.isFinite(up)) out.push(`uptime=${(up / 86400).toFixed(1)}d`);

  out.push(`cpu now=${n1(s.sample?.cpu?.total)}% | 24h avg=${n1(a.cpu_avg)} p95=${n1(a.cpu_p95)} max=${n1(a.cpu_max)}`
    + ` | 7d avg=${n1(w.cpu_avg)} p95=${n1(w.cpu_p95)}${slopeTag(s.trend?.cpu_pct_per_day, '%')}`
    + (s.cpuZ !== null ? ` | z_vs_same_hour_last_7d=${n1(s.cpuZ)}` : ''));

  const ramTotal = Number(s.sample?.ram?.total_kb);
  out.push(`ram now=${n1(s.sample?.ram?.used_pct)}% of ${kb(ramTotal)} `
    + `available=${kb(s.sample?.ram?.available_kb)} | 24h avg=${n1(a.ram_avg)} p95=${n1(a.ram_p95)}`
    + ` | 7d p95=${n1(w.ram_p95)}${slopeTag(s.trend?.ram_pct_per_day, '%')}`
    + (s.ramZ !== null ? ` | z=${n1(s.ramZ)}` : ''));

  const cores = Number(a.cores) || Number(s.sample?.load?.cores);
  out.push(`load 1m=${n1(s.sample?.load?.['1m'])} 5m=${n1(s.sample?.load?.['5m'])} 15m=${n1(s.sample?.load?.['15m'])}`
    + ` cores=${cores || '?'}`
    + (cores ? ` saturation=${n1(Number(s.sample?.load?.['1m']) / cores)}x (>1.0 means the run queue is backing up)` : '')
    + ` | 24h p95=${n1(a.load_p95)}`);

  if (s.disks.length) {
    out.push('disk:');
    for (const d of s.disks) {
      out.push(`  ${d.mount} (${d.device}) ${n1(d.used_pct)}% used ${kb(d.used_kb)}/${kb(d.size_kb)} avail ${kb(d.avail_kb)}`);
    }
    if (s.diskTotalPct !== null) out.push(`  whole machine: ${n1(s.diskTotalPct)}% used`);
    if (s.daysToFull !== null) {
      out.push(`  projection: ${s.capacity.mount} fills in ~${s.daysToFull.toFixed(1)} days at its own 7-day trend`
        + ` (${kb(s.capacity.avail_now)} free now, losing ${kb(Math.abs(Number(s.capacity.kb_per_sec)) * 86400)}/day)`);
    } else if (s.capacity) {
      out.push('  projection: no filesystem over 4GB is shrinking on a 7-day fit');
    }
  }
  if (s.net) {
    const rx = bps(s.net.rx_bps), tx = bps(s.net.tx_bps);
    if (rx || tx) out.push(`network rx=${rx || '?'} tx=${tx || '?'} (15m average)`);
  }
  const gpus = Array.isArray(s.sample?.gpu) ? s.sample.gpu : [];
  for (const g of gpus) {
    out.push(`gpu${g.id} ${g.name || ''} util=${n1(g.util_pct)}% `
      + `vram=${n1(g.mem_used_mb)}/${n1(g.mem_total_mb)}MB temp=${n1(g.temp_c)}C`
      + (a.gpu_util_avg != null ? ` | 24h util avg=${n1(a.gpu_util_avg)}%` : ''));
  }

  const pm2 = s.sample?.pm2;
  if (pm2?.present && pm2.accessible !== false) {
    const procs = Array.isArray(pm2.processes) ? pm2.processes : [];
    out.push(`pm2 online=${pm2.online} stopped=${pm2.stopped}`
      + (procs.length ? `: ${procs.map((p) => `${p.name}[${p.status}${p.restarts ? ` r${p.restarts}` : ''}]`).join(', ')}` : ''));
  }
  const dk = s.sample?.docker;
  if (dk?.present && dk.accessible !== false) {
    const cs = Array.isArray(dk.containers) ? dk.containers : [];
    out.push(`docker running=${dk.running}/${dk.total} exited=${dk.exited}`
      + (cs.length ? `: ${cs.map((c) => `${c.name || c.names}[${c.state || c.status}]`).join(', ')}` : ''));
  }
  if (s.missingServices.length) {
    out.push(`EXPECTED BUT NOT RUNNING: ${s.missingServices.join(', ')}`);
  }
  const http = Array.isArray(s.sample?.http) ? s.sample.http : [];
  for (const h of http) out.push(`http ${h.url} -> ${h.status_code} in ${h.latency_ms}ms`);

  const db = s.sample?.databases || {};
  for (const k of ['mysql', 'postgres']) {
    const d = db[k];
    if (d?.present) {
      out.push(`${k} reachable=${d.reachable !== false} active=${d.active} total=${d.total} max=${d.max}`
        + (Number(d.max) > 0 ? ` (${n1((100 * Number(d.active)) / Number(d.max))}% of max)` : ''));
    }
  }
  if (s.ndb) out.push(ndbSummary(s.ndb));

  if (s.incidents.length) {
    out.push('active incidents:');
    for (const i of s.incidents) out.push(`  ${incidentLine(i)}`);
  }
  return out.join('\n');
}

export function incidentLine(i) {
  const cond = i.metric
    ? `${i.metric} ${i.comparator || '?'} ${i.threshold ?? '?'}${i.value != null ? ` (now ${n1(i.value)})` : ''}`
    : 'no metric';
  return `${i.id} server=${i.server_id} ${i.severity}/${i.status} rule="${i.rule_name || 'n/a'}" ${cond} `
    + `since ${ago(i.started_at)} ago${i.message ? ` — ${i.message}` : ''}`;
}

/**
 * NDB is summarised rather than dumped because the interesting facts are
 * relational: which node group a dead node belonged to decides whether the
 * cluster is degraded or down, and the node list alone does not say that.
 */
export function ndbSummary(ndb) {
  if (!ndb?.present) return 'ndb: not present';
  if (ndb.accessible === false) return `ndb: present but unreadable — ${ndb.reason || 'no reason given'}`;
  const nodes = Array.isArray(ndb.nodes) ? ndb.nodes : [];
  const parts = [`ndb (source=${ndb.source || '?'}): data nodes ${ndb.data_nodes_started}/${ndb.data_nodes_configured} started`];
  if (ndb.unhealthy > 0) parts.push(`${ndb.unhealthy} NOT STARTED`);
  if (ndb.node_groups_known === false) parts.push('node-group verdict unavailable (a dead node could not be attributed to a group)');
  else parts.push(`node groups ${ndb.node_groups_total} total, ${ndb.node_groups_down} fully down`);
  if (ndb.data_memory_pct != null) parts.push(`data memory ${n1(ndb.data_memory_pct)}%`);
  if (ndb.index_memory_pct != null) parts.push(`index memory ${n1(ndb.index_memory_pct)}%`);
  if (ndb.arbitrator_connected !== undefined) parts.push(`arbitrator ${ndb.arbitrator_connected ? 'connected' : 'LOST'}`);

  // Group membership, so the model can reason about redundancy rather than
  // counting nodes: a group with one live node survives, but only just.
  const groups = {};
  for (const nd of nodes) {
    if (nd.type !== 'NDB') continue;
    const g = nd.group === undefined ? 'unknown' : String(nd.group);
    (groups[g] ||= []).push(nd);
  }
  const gl = Object.entries(groups).map(([g, ns]) => {
    const live = ns.filter((x) => x.status === 'STARTED').length;
    return `group ${g}: ${live}/${ns.length} live (${ns.map((x) => `id${x.id}@${x.host || '?'}=${x.status}`).join(' ')})`
      + (live === 1 && ns.length > 1 ? ' ← LAST SURVIVOR, losing it takes the cluster offline' : '')
      + (live === 0 ? ' ← GROUP DOWN' : '');
  });
  const other = nodes.filter((x) => x.type !== 'NDB')
    .map((x) => `${x.type} id${x.id}@${x.host || '?'}=${x.status}`);
  return [parts.join(', '), ...gl.map((x) => `  ${x}`), other.length ? `  other nodes: ${other.join(' ')}` : '']
    .filter(Boolean).join('\n');
}

/** Header block: the shape of the fleet in four lines. */
export function fleetHeader(snap) {
  const t = snap.totals;
  return `Fleet: ${t.servers} servers — ${t.online} online, ${t.warning} warning, ${t.critical} critical, ${t.offline} offline.\n`
    + `Active incidents: ${t.incidents}. PM2 processes online: ${t.pm2}. Docker containers running: ${t.docker}.\n`
    + `Server time: ${new Date().toISOString()}`;
}
