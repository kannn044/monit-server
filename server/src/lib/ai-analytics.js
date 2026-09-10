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

import { q, pool } from '../db/pool.js';
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

/**
 * Sampled statistics, computed from raw samples rather than from metrics_1h.
 *
 * metrics_1h is the obvious source and it is a trap. WITH TimescaleDB it is a
 * continuous aggregate and costs nothing; WITHOUT it — which is the fallback
 * the migration runner silently chooses when the extension is unavailable — it
 * is a plain VIEW that aggregates raw rows every time it is read. Measured on
 * eight servers holding a week at the 10-second interval (484k rows), the 7-day
 * percentile query took 7.8 seconds and the 7-day trend 4.2. Scale that to a
 * real fleet and a chat request spends over a minute in SQL before the model is
 * ever called: the browser shows a pending request, the GPU is idle, and nginx
 * eventually returns 504.
 *
 * So these queries do not aggregate a week of rows. They take ONE sample per
 * bucket with a LATERAL lookup — an index seek each on (server_id, time DESC) —
 * and compute from those: 144 points per server over 24 hours, 168 over a week.
 * Same queries, same shape, same cost on either deployment: single-digit
 * milliseconds.
 *
 * The tradeoff is honest and small: a p95 over 144 samples is not identical to
 * one over 8,640, and a sampled max can miss a spike that lasted seconds. For
 * "is this number normal for this host" that difference does not change any
 * answer, and the alert engine — which does watch every sample — is what
 * catches the spike.
 */
function sampledStatsSql(span, step) {
  return `
    WITH pts AS (
      SELECT s.id AS server_id, g.b, m.cpu, m.ram, m.load, m.disk
        FROM servers s
        CROSS JOIN generate_series(date_trunc('hour', now()) - interval '${span}',
                                   now(), interval '${step}') g(b)
        CROSS JOIN LATERAL (
          SELECT sm.cpu, sm.ram, sm.load, sm.disk
            FROM system_metrics sm
           WHERE sm.server_id = s.id
             AND sm.time >= g.b AND sm.time < g.b + interval '${step}'
           ORDER BY sm.time DESC LIMIT 1
        ) m
       WHERE s.archived_at IS NULL
    ), v AS (
      SELECT server_id, b,
             (cpu->>'total')::double precision      AS cpu,
             (ram->>'used_pct')::double precision   AS ram,
             (ram->>'available_kb')::double precision AS ram_avail,
             (load->>'1m')::double precision        AS load1,
             (load->>'cores')::int                  AS cores,
             disk_max_used_pct(disk)                AS disk_pct,
             disk_min_avail_kb(disk)                AS disk_avail
        FROM pts
    )
    SELECT server_id,
           avg(cpu)                                            AS cpu_avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu)    AS cpu_p95,
           max(cpu)                                            AS cpu_max,
           avg(ram)                                            AS ram_avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ram)    AS ram_p95,
           avg(disk_pct)                                       AS disk_avg,
           min(disk_avail)                                     AS disk_avail_min,
           avg(load1)                                          AS load_avg,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY load1)  AS load_p95,
           max(cores)                                          AS cores,
           NULL::double precision                              AS gpu_util_avg,
           NULL::double precision                              AS gpu_mem_max,
           count(*)                                            AS buckets
      FROM v GROUP BY server_id`;
}

/**
 * The week in one pass: trend, and the same-hour baseline the z-score needs.
 *
 * Both come off the same sampled points, so the week is walked once instead of
 * three times. regr_slope() ships with Postgres, so "will this fill up, and
 * when" needs no extension and no library — and being a closed form it cannot
 * drift the way a model's arithmetic does.
 *
 * The baseline compares now against the SAME HOUR on other days rather than
 * against a flat weekly average, which is the cheapest way to stop a nightly
 * backup window from reading as an anomaly every night.
 */
const WEEK_SQL = `
  WITH pts AS (
    SELECT s.id AS server_id, g.b, m.cpu, m.ram, m.disk
      FROM servers s
      CROSS JOIN generate_series(date_trunc('hour', now()) - interval '7 days',
                                 now(), interval '1 hour') g(b)
      CROSS JOIN LATERAL (
        SELECT sm.cpu, sm.ram, sm.disk FROM system_metrics sm
         WHERE sm.server_id = s.id
           AND sm.time >= g.b AND sm.time < g.b + interval '1 hour'
         ORDER BY sm.time DESC LIMIT 1
      ) m
     WHERE s.archived_at IS NULL
  ), v AS (
    SELECT server_id, b, extract(epoch FROM b) AS t,
           (cpu->>'total')::double precision    AS cpu,
           (ram->>'used_pct')::double precision AS ram,
           disk_max_used_pct(disk)              AS disk_pct
      FROM pts
  )
  SELECT server_id,
         regr_slope(ram,      t) * 86400 AS ram_pct_per_day,
         regr_slope(disk_pct, t) * 86400 AS disk_pct_per_day,
         regr_slope(cpu,      t) * 86400 AS cpu_pct_per_day,
         count(*)                        AS buckets,
         avg(cpu)        FILTER (WHERE extract(hour FROM b) = extract(hour FROM now())
                                   AND b < date_trunc('hour', now())) AS cpu_mean,
         stddev_pop(cpu) FILTER (WHERE extract(hour FROM b) = extract(hour FROM now())
                                   AND b < date_trunc('hour', now())) AS cpu_sd,
         avg(ram)        FILTER (WHERE extract(hour FROM b) = extract(hour FROM now())
                                   AND b < date_trunc('hour', now())) AS ram_mean,
         stddev_pop(ram) FILTER (WHERE extract(hour FROM b) = extract(hour FROM now())
                                   AND b < date_trunc('hour', now())) AS ram_sd
    FROM v GROUP BY server_id`;

/**
 * Network rate from the newest and oldest raw sample in a ten-minute window.
 *
 * Not from metrics_1m: without the timescaledb extension that name is a plain
 * VIEW that aggregates the whole table, and the predicate on `bucket` sits on
 * top of a date_trunc the planner cannot turn into an index scan. On a fleet
 * with a few million rows that is a table scan per chat message. Ten minutes of
 * raw samples is about sixty rows per server and rides the
 * (server_id, time DESC) index.
 */
const NET_SQL = `
  WITH r AS (
    SELECT server_id, time,
           net_counter_sum(network, 'rx_bytes') AS rx,
           net_counter_sum(network, 'tx_bytes') AS tx
      FROM system_metrics
     WHERE time > now() - interval '10 minutes'
  ), d AS (
    SELECT server_id,
           (array_agg(rx ORDER BY time DESC))[1] - (array_agg(rx ORDER BY time))[1] AS rxd,
           (array_agg(tx ORDER BY time DESC))[1] - (array_agg(tx ORDER BY time))[1] AS txd,
           extract(epoch FROM (max(time) - min(time)))                              AS secs
      FROM r GROUP BY server_id
  )
  SELECT server_id,
         CASE WHEN secs > 0 AND rxd >= 0 THEN rxd / secs END AS rx_bps,
         CASE WHEN secs > 0 AND txd >= 0 THEN txd / secs END AS tx_bps
    FROM d`;

/**
 * Per-mount disk trend, and the projection that comes out of it.
 *
 * This cannot come from metrics_1h: that rollup stores min(avail) across every
 * mount, and on almost every host the smallest mount is /boot — 900MB, 90% full
 * by design, and never changing. Fitting a line to that reports "not shrinking"
 * for a machine whose root filesystem is filling steadily, which is the exact
 * question a capacity forecast exists to answer.
 *
 * So it goes back to the raw samples — but it must not READ seven days of them.
 * At a 10-second interval that is sixty thousand rows per server per week, and
 * scanning them all (then expanding a jsonb array per row) is slow enough to
 * look like a hung request. Instead one sample is picked per six-hour window
 * with a LATERAL lookup, which is an index seek each: 29 points per server, and
 * 29 points is more than enough to fit a straight line to a disk.
 *
 * Mounts under 4 GiB are ignored — small enough to be a boot or EFI partition,
 * large enough to keep every real filesystem.
 */
const DISK_TREND_SQL = `
  WITH hrs AS (
    SELECT generate_series(date_trunc('hour', now()) - interval '7 days',
                           date_trunc('hour', now()),
                           interval '6 hours') AS h
  ), sampled AS (
    SELECT s.id AS server_id, hrs.h AS b, m.disk
      FROM servers s
      CROSS JOIN hrs
      CROSS JOIN LATERAL (
        SELECT sm.disk FROM system_metrics sm
         WHERE sm.server_id = s.id
           AND sm.time >= hrs.h AND sm.time < hrs.h + interval '6 hours'
         ORDER BY sm.time DESC LIMIT 1
      ) m
     WHERE s.archived_at IS NULL
  ), mounts AS (
    SELECT server_id, b,
           d->>'mount'                        AS mount,
           -- double precision, not bigint: these come from a shell script via
           -- jsonb, and one host reporting "200000000.0" would otherwise abort
           -- the whole fleet's capacity forecast with a cast error.
           (d->>'size_kb')::double precision   AS size_kb,
           (d->>'avail_kb')::double precision  AS avail_kb,
           (d->>'used_pct')::double precision  AS used_pct
      FROM sampled, LATERAL jsonb_array_elements(COALESCE(disk, '[]'::jsonb)) d
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
         CASE WHEN kb_per_sec < 0 AND buckets >= 8
              THEN avail_now / (-kb_per_sec) / 86400 END AS days_to_full
    FROM fitted
   ORDER BY server_id,
            COALESCE(CASE WHEN kb_per_sec < 0 AND buckets >= 8
                          THEN avail_now / (-kb_per_sec) END, 1e18) ASC,
            used_pct DESC`;

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
 * Run the optional analytics on one connection, under a statement timeout.
 *
 * These are the queries whose cost depends on how the database is deployed.
 * With TimescaleDB, metrics_1h is a continuous aggregate and they are trivial.
 * Without it, the migration creates metrics_1m/metrics_1h as plain VIEWs that
 * aggregate the whole table, and the same query can take minutes — which the
 * user experiences as a chat request that hangs forever with an idle GPU,
 * because nothing has reached the model yet.
 *
 * So they are bounded and optional. If they time out, the chat still answers
 * from current values; it just cannot talk about percentiles or trends. A
 * degraded answer beats a spinner.
 *
 * One client, sequentially: SET LOCAL needs a transaction, and taking six
 * clients from a pool of ten to run six queries in parallel is how the ingest
 * path starts waiting behind the chat page.
 */
let analyticsCache = { at: 0, data: null };

async function analytics(log) {
  // Percentiles over 24 hours and trends over a week do not move between two
  // messages typed a minute apart. Recomputing them per message is the single
  // easiest way to make a chat feel slow for no gain.
  if (analyticsCache.data && Date.now() - analyticsCache.at < config.aiAnalyticsTtlMs) {
    return analyticsCache.data;
  }
  const empty = { s24: [], s7d: [], week: [], net: [] };
  const client = await pool.connect();
  const out = { ...empty };
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${config.aiAnalyticsTimeoutMs}ms'`);
    const steps = [
      ['s24', sampledStatsSql('24 hours', '10 minutes')],
      ['s7d', sampledStatsSql('7 days', '1 hour')],
      ['week', WEEK_SQL],
      ['net', NET_SQL],
    ];
    for (const [key, sql] of steps) {
      try {
        const { rows } = await client.query(sql);
        out[key] = rows;
      } catch (e) {
        // A timeout aborts the transaction, so the rest of the batch cannot run
        // on this connection — start a clean one and carry on with what is left.
        log?.warn({ step: key, err: e.message }, 'ai analytics step skipped');
        await client.query('ROLLBACK').catch(() => {});
        await client.query('BEGIN READ ONLY').catch(() => {});
        await client.query(`SET LOCAL statement_timeout = '${config.aiAnalyticsTimeoutMs}ms'`).catch(() => {});
      }
    }
    await client.query('ROLLBACK').catch(() => {});
  } catch (e) {
    log?.warn(e, 'ai analytics unavailable — answering from current values only');
  } finally {
    client.release();
  }
  analyticsCache = { at: Date.now(), data: out };
  return out;
}

/**
 * Cached for five minutes.
 *
 * It is the one query here that looks back a week, and a seven-day trend does
 * not move between two messages typed a minute apart.
 */
let diskTrendCache = { at: 0, map: {} };
async function diskTrend(log) {
  if (Date.now() - diskTrendCache.at < 5 * 60_000) return diskTrendCache.map;
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${config.aiAnalyticsTimeoutMs}ms'`);
    const { rows } = await client.query(DISK_TREND_SQL);
    await client.query('ROLLBACK');
    diskTrendCache = { at: Date.now(), map: byServer(rows) };
  } catch (e) {
    log?.warn(e, 'disk trend unavailable — no capacity projection this time');
    // Cache the failure too, so a database that cannot answer this is not asked
    // again on every single message.
    diskTrendCache = { at: Date.now(), map: {} };
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.release();
  }
  return diskTrendCache.map;
}

/**
 * The snapshot, cached briefly.
 *
 * A single chat turn asks for it once, then several tools read from the same
 * object; a follow-up question a few seconds later wants the same picture. The
 * TTL is short enough that "now" still means now, and long enough that a
 * conversation does not re-query the fleet on every message.
 */
let snapCache = { at: 0, snap: null, pending: null };

export async function fleetSnapshot({ force = false, log } = {}) {
  if (!force && snapCache.snap && Date.now() - snapCache.at < config.aiSnapshotTtlMs) {
    return snapCache.snap;
  }
  // Two people asking at the same moment should produce one round of queries,
  // not two.
  if (snapCache.pending) return snapCache.pending;
  snapCache.pending = buildSnapshot(log).then((snap) => {
    snapCache = { at: Date.now(), snap, pending: null };
    return snap;
  }).catch((e) => {
    snapCache.pending = null;
    throw e;
  });
  return snapCache.pending;
}

/**
 * One round trip's worth of everything the chat could need about the fleet.
 *
 * The essential queries run first and are not optional: without servers, their
 * latest sample and the open incidents there is nothing to say. All four are
 * bounded by primary keys or by the (server_id, time DESC) index, so they stay
 * fast whatever the deployment. Everything after them is enrichment.
 */
async function buildSnapshot(log) {
  const staleS = config.sampleIntervalS * config.offlineFactor * 2;
  const [{ rows: servers }, { rows: latest }, { rows: incidents }, { rows: expected }] =
    await Promise.all([
      q(SERVERS_SQL),
      q(LATEST_SQL, [staleS]),
      q(INCIDENTS_SQL),
      q(EXPECTED_SQL),
    ]);

  const [extra, diskCap] = await Promise.all([analytics(log), diskTrend(log)]);

  const L = byServer(latest), A = byServer(extra.s24), B = byServer(extra.s7d);
  // Trend and baseline now come off the same weekly pass, so one map serves both.
  const T = byServer(extra.week), Z = T, N = byServer(extra.net);
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
    // answer when the slope is flat or there were too few points to fit one.
    const cap = D[s.id] || null;
    const daysToFull = cap?.days_to_full != null ? Number(cap.days_to_full) : null;
    // Prefer the live reading for the mount the fit chose — the fit's own "now"
    // is up to six hours old.
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
    // Told to the model so it never presents a partial picture as complete.
    degraded: !extra.s24.length,
  };

  return { list, byId: Object.fromEntries(list.map((s) => [s.id, s])), totals, incidents };
}

/**
 * Time every part of the snapshot separately.
 *
 * When the chat page hangs, the only question worth answering first is "which
 * step". This turns that from a guess into a number.
 */
export async function snapshotTimings() {
  const staleS = config.sampleIntervalS * config.offlineFactor * 2;
  const steps = [
    ['servers', SERVERS_SQL, []],
    ['latest_sample', LATEST_SQL, [staleS]],
    ['incidents', INCIDENTS_SQL, []],
    ['expected_services', EXPECTED_SQL, []],
    ['stats_24h', sampledStatsSql('24 hours', '10 minutes'), []],
    ['stats_7d', sampledStatsSql('7 days', '1 hour'), []],
    ['week_trend_baseline', WEEK_SQL, []],
    ['network_rate', NET_SQL, []],
    ['disk_trend', DISK_TREND_SQL, []],
  ];
  const out = [];
  for (const [name, sql, params] of steps) {
    const t0 = Date.now();
    try {
      const { rows } = await q(sql, params);
      out.push({ step: name, ms: Date.now() - t0, rows: rows.length });
    } catch (e) {
      out.push({ step: name, ms: Date.now() - t0, error: e.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// rendering for the prompt
// ---------------------------------------------------------------------------

/**
 * One dense line per server, carrying only the metrics the question is about.
 *
 * The full line is roughly 180 characters. On a thirty-server fleet that is
 * 5,400 characters of context — most of it irrelevant to any one question, and
 * on a GPU with a small `--max-model-len` it is the difference between the
 * model having room to answer and spending its whole budget reading. A question
 * about disks does not need pm2 counts, and paying for them costs an answer.
 *
 * `aspects` is a Set of metric families ('disk', 'ram', 'cpu', 'load', 'net',
 * 'svc', 'ndb'); null or empty means everything, which is what a general
 * "what's wrong" question wants.
 */
export function fleetLine(s, aspects = null) {
  const want = (k) => !aspects || !aspects.size || aspects.has(k);
  const p = [];
  const a24 = s.stats24 || {};

  p.push(`- ${s.name} [${s.health}]`);
  if (s.health === 'offline') {
    p.push(`last sample ${ago(s.last_seen)} ago`);
    return p.join(' ');
  }

  if (want('cpu')) {
    const cpu = n1(s.sample?.cpu?.total);
    if (cpu !== null) p.push(`cpu ${cpu}%${a24.cpu_p95 ? `(24h p95 ${n1(a24.cpu_p95)})` : ''}${slopeTag(s.trend?.cpu_pct_per_day)}`);
  }
  if (want('ram')) {
    const ram = n1(s.sample?.ram?.used_pct);
    if (ram !== null) p.push(`ram ${ram}%${a24.ram_p95 ? `(24h p95 ${n1(a24.ram_p95)})` : ''}${slopeTag(s.trend?.ram_pct_per_day)}`);
  }
  if (want('disk') && s.worstDisk) {
    let d = `disk ${s.worstDisk.mount} ${n1(s.worstDisk.used_pct)}% avail ${kb(s.worstDisk.avail_kb)}`;
    if (s.diskTotalPct !== null) d += ` (machine ${n1(s.diskTotalPct)}%)`;
    // Three distinct states, and conflating the last two put a "แบนราบ" on a
    // line whose own computed lead said "full in 187 days".
    if (s.daysToFull === null) { if (s.capacity) d += ' (แบนราบ)'; }
    else if (s.daysToFull < 90) d += ` FULL~${s.daysToFull.toFixed(1)}d`;
    else d += ` FULL~${Math.round(s.daysToFull)}d (ยังอีกนาน)`;
    p.push(d);
    // A small partition at 99% is not a capacity story, but a full /boot does
    // break the next kernel upgrade, so it is worth one short clause.
    if (s.tightestDisk && s.tightestDisk.mount !== s.worstDisk.mount
        && Number(s.tightestDisk.used_pct) >= 95) {
      p.push(`small mount ${s.tightestDisk.mount} ${n1(s.tightestDisk.used_pct)}%`);
    }
  }
  if (want('load')) {
    const cores = Number(a24.cores) || Number(s.sample?.load?.cores);
    const l1 = Number(s.sample?.load?.['1m']);
    if (Number.isFinite(l1) && cores > 0) p.push(`load ${n1(l1 / cores)}/core`);
  }
  if (want('net') && s.net) {
    const rx = bps(s.net.rx_bps), tx = bps(s.net.tx_bps);
    if (rx || tx) p.push(`net rx ${rx || '?'} tx ${tx || '?'}`);
  }
  if (want('svc')) {
    if (s.sample?.pm2?.accessible !== false && s.sample?.pm2?.present) {
      p.push(`pm2 ${s.sample.pm2.online}on/${(s.sample.pm2.online || 0) + (s.sample.pm2.stopped || 0)}`);
    }
    if (s.sample?.docker?.accessible !== false && s.sample?.docker?.present) {
      p.push(`docker ${s.sample.docker.running}/${s.sample.docker.total}`);
    }
  }
  if (want('ndb') && s.ndb?.accessible) {
    p.push(`ndb ${s.ndb.data_nodes_started}/${s.ndb.data_nodes_configured}nodes`
      + (s.ndb.data_memory_pct != null ? ` mem ${n1(s.ndb.data_memory_pct)}%` : ''));
  }

  // Always kept, whatever the question: an anomaly or a missing service is
  // never irrelevant, and each costs a handful of characters.
  if (want('cpu') && Math.abs(s.cpuZ ?? 0) >= 2.5) p.push(`ANOM cpu z=${n1(s.cpuZ)}`);
  if (want('ram') && Math.abs(s.ramZ ?? 0) >= 2.5) p.push(`ANOM ram z=${n1(s.ramZ)}`);
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
