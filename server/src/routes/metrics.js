import { q } from '../db/pool.js';
import { requireRole } from '../lib/auth.js';
import { extractMetric, METRIC_UNITS } from '../lib/metrics.js';
import { serversWithHealth } from './servers.js';

// metric path → continuous-aggregate column
const CAGG_COL = {
  'cpu.total': 'cpu_total_pct', 'ram.used_pct': 'ram_used_pct', 'ram.free_kb': 'ram_free_kb',
  'ram.available_kb': 'ram_available_kb', 'load.1m': 'load_1m', 'load.5m': 'load_5m',
  'disk.total_used_pct': 'disk_total_used_pct',
  'load.15m': 'load_15m', 'disk.used_pct': 'disk_used_pct', 'disk.avail_kb': 'disk_avail_kb',
  'gpu.util_pct': 'gpu_util_pct', 'gpu.mem_used_pct': 'gpu_mem_used_pct', 'uptime_s': 'uptime_s',
};

/**
 * Cumulative counters → per-second rate.
 * points: sorted asc, { t, v: counterValue }.
 * Emits null (a gap in the line) rather than a misleading value when:
 *   - the counter went backwards (reboot / interface reset), or
 *   - the two samples are further apart than `maxGapS` — a "rate" averaged over
 *     a long outage is not a rate anyone can act on.
 */
// Max sample spacing still treated as continuous, per bucket size (5 × the
// nominal step). Beyond this the line breaks instead of drawing a fake average.
const GAP_S = { raw: 300, '1m': 300, '1h': 5 * 3600 };

const counterToRate = (points, maxGapS = GAP_S.raw) => {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (new Date(points[i].t) - new Date(points[i - 1].t)) / 1000;
    const dv = points[i].v - points[i - 1].v;
    const ok = dt > 0 && dt <= maxGapS && dv >= 0;
    out.push({ t: points[i].t, v: ok ? dv / dt : null });
  }
  return out;
};

function parseRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 3600 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
  return { from, to };
}

function pickBucket(query, from, to) {
  if (query.bucket && ['raw', '1m', '1h'].includes(query.bucket)) return query.bucket;
  const spanH = (to - from) / 3600e3;
  if (spanH <= 1) return 'raw';
  if (spanH <= 48) return '1m';
  return '1h';
}

export default async function metricsRoutes(app) {
  // Single-metric series (spec §7.3)
  app.get('/api/v1/servers/:id/metrics', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const metric = req.query.metric || 'cpu.total';
    const range = parseRange(req.query);
    if (!range) return reply.code(400).send({ title: 'Invalid from/to', status: 400 });
    const { from, to } = range;
    const bucket = pickBucket(req.query, from, to);
    const agg = ['avg', 'max', 'min'].includes(req.query.agg) ? req.query.agg : 'avg';
    const id = req.params.id;
    let points = [];

    const isNetRate = metric === 'net.rx_bps' || metric === 'net.tx_bps';
    if (bucket === 'raw') {
      const { rows } = await q(
        `SELECT time, cpu, ram, load, uptime_s, disk, network, gpu, docker, pm2, http, databases
         FROM system_metrics WHERE server_id = $1 AND time BETWEEN $2 AND $3
         ORDER BY time ASC LIMIT 5000`, [id, from.toISOString(), to.toISOString()]);
      if (isNetRate) {
        const field = metric === 'net.rx_bps' ? 'rx_bytes' : 'tx_bytes';
        const counters = rows.map((r) => ({
          t: r.time,
          v: (Array.isArray(r.network) ? r.network : []).reduce((a, n) => a + (Number(n[field]) || 0), 0),
        }));
        points = counterToRate(counters);
      } else {
        points = rows.map((r) => ({ t: r.time, v: extractMetric(metric, r) }));
      }
    } else {
      const view = bucket === '1m' ? 'metrics_1m' : 'metrics_1h';
      if (isNetRate) {
        const col = metric === 'net.rx_bps' ? 'net_rx_bytes' : 'net_tx_bytes';
        const { rows } = await q(
          `SELECT bucket AS t, ${col}::double precision AS v FROM ${view}
           WHERE server_id = $1 AND bucket BETWEEN $2 AND $3 ORDER BY bucket ASC`, [id, from, to]);
        points = counterToRate(rows.map((r) => ({ t: r.t, v: Number(r.v) })), GAP_S[bucket]);
      } else {
        const col = CAGG_COL[metric];
        if (!col) return reply.code(400).send({ title: `Unknown metric for bucket ${bucket}: ${metric}`, status: 400 });
        // avg is precomputed; max/min fall back to the stored max column where available
        const expr = agg === 'max' && metric === 'cpu.total' ? 'cpu_max_pct' : col;
        const { rows } = await q(
          `SELECT bucket AS t, ${expr}::double precision AS v FROM ${view}
           WHERE server_id = $1 AND bucket BETWEEN $2 AND $3 ORDER BY bucket ASC`, [id, from, to]);
        points = rows.map((r) => ({ t: r.t, v: r.v === null ? null : Number(r.v) }));
      }
    }
    return { server_id: id, metric, unit: METRIC_UNITS[metric] || '', bucket, agg, points };
  });

  // Rich multi-series for the server-detail charts
  app.get('/api/v1/servers/:id/series', { preHandler: requireRole('viewer') }, async (req, reply) => {
    // cpu | ram | disk | net | load | gpu (utilization) | gpuvram (VRAM)
    // Note: each kind returns series that share ONE unit — never mix % and bytes
    // on a single chart.
    const kind = req.query.kind || 'cpu';
    const range = parseRange(req.query);
    if (!range) return reply.code(400).send({ title: 'Invalid from/to', status: 400 });
    const { from, to } = range;
    const id = req.params.id;
    const spanH = (to - from) / 3600e3;

    if (spanH <= 3) {
      // raw samples → per-core / per-mount / per-iface / per-gpu series
      const { rows } = await q(
        `SELECT time, cpu, ram, load, disk, network, gpu FROM system_metrics
         WHERE server_id = $1 AND time BETWEEN $2 AND $3 ORDER BY time ASC LIMIT 3000`,
        [id, from.toISOString(), to.toISOString()]);
      const series = {};
      const push = (name, t, v) => { (series[name] ||= []).push({ t, v }); };
      for (const r of rows) {
        const t = r.time;
        if (kind === 'cpu') {
          push('total', t, r.cpu?.total ?? null);
          for (const c of r.cpu?.cores || []) push(`core ${c.id}`, t, c.used ?? null);
        } else if (kind === 'ram') {
          // all series in GB — used_pct is surfaced as a stat tile, not mixed in here
          push('used', t, r.ram?.used_kb != null ? r.ram.used_kb / 1048576 : null);
          push('cached', t, r.ram?.cached_kb != null ? r.ram.cached_kb / 1048576 : null);
          push('available', t, r.ram?.available_kb != null ? r.ram.available_kb / 1048576 : null);
        } else if (kind === 'disk') {
          for (const d of r.disk || []) push(d.mount, t, d.used_pct ?? null);
        } else if (kind === 'net') {
          for (const n of r.network || []) {
            push(`${n.iface} rx`, t, Number(n.rx_bytes) || 0);
            push(`${n.iface} tx`, t, Number(n.tx_bytes) || 0);
          }
        } else if (kind === 'gpu') {
          for (const g of r.gpu || []) push(`gpu${g.id}`, t, g.util_pct ?? null);
        } else if (kind === 'gpuvram') {
          for (const g of r.gpu || []) {
            push(`gpu${g.id}`, t, g.mem_total_mb > 0 ? (100 * g.mem_used_mb) / g.mem_total_mb : null);
          }
        } else if (kind === 'load') {
          push('1m', t, r.load?.['1m'] ?? null);
          push('5m', t, r.load?.['5m'] ?? null);
          push('15m', t, r.load?.['15m'] ?? null);
          push('cores', t, r.load?.cores ?? null);
        }
      }
      if (kind === 'net') { // counters → rates
        for (const name of Object.keys(series)) series[name] = counterToRate(series[name]);
      }
      return { server_id: id, kind, bucket: 'raw', series };
    }

    // long ranges → aggregated single/dual series from caggs
    const view = spanH <= 48 ? 'metrics_1m' : 'metrics_1h';
    const { rows } = await q(
      `SELECT bucket AS t, cpu_total_pct, ram_used_pct, disk_used_pct, disk_avail_kb,
              load_1m, load_5m, load_15m, cores, gpu_util_pct, gpu_mem_used_pct,
              net_rx_bytes, net_tx_bytes
       FROM ${view} WHERE server_id = $1 AND bucket BETWEEN $2 AND $3 ORDER BY bucket ASC`,
      [id, from, to]);
    const series = {};
    const mk = (name, f) => { series[name] = rows.map((r) => ({ t: r.t, v: r[f] === null ? null : Number(r[f]) })); };
    if (kind === 'cpu') mk('total', 'cpu_total_pct');
    else if (kind === 'ram') { mk('available', 'ram_available_kb'); series.available = series.available.map((p) => ({ t: p.t, v: p.v === null ? null : p.v / 1048576 })); }
    else if (kind === 'disk') mk('worst mount', 'disk_used_pct');
    else if (kind === 'gpu') mk('utilization', 'gpu_util_pct');
    else if (kind === 'gpuvram') mk('vram used', 'gpu_mem_used_pct');
    else if (kind === 'load') { mk('1m', 'load_1m'); mk('5m', 'load_5m'); mk('15m', 'load_15m'); }
    else if (kind === 'net') {
      const gap = GAP_S[view === 'metrics_1m' ? '1m' : '1h'];
      series['rx'] = counterToRate(rows.map((r) => ({ t: r.t, v: Number(r.net_rx_bytes) || 0 })), gap);
      series['tx'] = counterToRate(rows.map((r) => ({ t: r.t, v: Number(r.net_tx_bytes) || 0 })), gap);
    }
    return { server_id: id, kind, bucket: view === 'metrics_1m' ? '1m' : '1h', series };
  });

  // Fleet landing page
  // The Fleet page polls this every 10 s, so everything in it is on the hot path.
  // `top` and `sparkline_24h` are opt-in (?include=top,sparkline): the sparkline
  // aggregated 24 h of RAW samples through the metrics_1m view, which on plain
  // PostgreSQL is not materialised — a full scan of system_metrics (1.6 s over
  // 1.7 M rows) for a chart the dashboard does not draw.
  app.get('/api/v1/fleet/health', { preHandler: requireRole('viewer') }, async (req) => {
    const include = String(req.query.include || '').split(',').map((x) => x.trim());
    const wantSpark = include.includes('sparkline');
    const wantTop = include.includes('top') || wantSpark;
    const servers = await serversWithHealth({});
    const counts = {
      total: servers.length,
      online: servers.filter((s) => s.health === 'online').length,
      offline: servers.filter((s) => s.health === 'offline').length,
      warning: servers.filter((s) => s.health === 'warning').length,
      critical: servers.filter((s) => s.health === 'critical').length,
    };
    const ids = servers.map((s) => s.id);
    let top = { cpu: [], ram: [], disk: [], load: [] };
    let spark = [];
    if (ids.length) {
      // Current values straight from the newest raw sample per server: the cards
      // show "right now", and this avoids the up-to-a-minute lag of the rollups.
      const { rows: cur } = await q(
        `SELECT DISTINCT ON (server_id) server_id, time, cpu, ram, disk, load, uptime_s
         FROM system_metrics WHERE server_id = ANY($1) AND time > now() - INTERVAL '10 minutes'
         ORDER BY server_id, time DESC`, [ids]);
      const byServer = new Map(cur.map((r) => [r.server_id, r]));
      for (const s of servers) {
        const r = byServer.get(s.id);
        s.current = r ? {
          time: r.time,
          cpu: extractMetric('cpu.total', r),
          ram: extractMetric('ram.used_pct', r),
          disk: extractMetric('disk.total_used_pct', r),
          disk_avail_kb: extractMetric('disk.total_avail_kb', r),
          disk_size_kb: extractMetric('disk.total_size_kb', r),
          load_1m: extractMetric('load.1m', r),
          cores: r.load?.cores ?? null,
          uptime_s: r.uptime_s,
        } : null;
      }
      if (wantTop) {
        const byMetric = (key) => servers
          .filter((s) => s.current && s.current[key] !== null)
          .map((s) => ({ server_id: s.id, value: Number(s.current[key]) }))
          .sort((a, b) => b.value - a.value).slice(0, 5);
        top = { cpu: byMetric('cpu'), ram: byMetric('ram'), disk: byMetric('disk'), load: byMetric('load_1m') };
      }
      if (wantSpark) {
        // Straight off system_metrics: `time > …` can use the index, whereas the
        // view's `bucket > …` becomes date_trunc('minute', time) > … and cannot.
        const { rows: sp } = await q(
          `SELECT to_timestamp(floor(extract(epoch FROM time) / 1800) * 1800) AS t,
                  avg((cpu->>'total')::double precision)    AS cpu,
                  avg((ram->>'used_pct')::double precision) AS ram,
                  avg(disk_total_used_pct(disk))            AS disk
           FROM system_metrics WHERE time > now() - INTERVAL '24 hours' GROUP BY t ORDER BY t`);
        spark = sp.map((r) => ({ t: r.t, cpu: r.cpu === null ? null : Number(r.cpu), ram: r.ram === null ? null : Number(r.ram), disk: r.disk === null ? null : Number(r.disk) }));
      }
    }
    const { rows: ticker } = await q(
      `SELECT id, rule_name, severity, server_id, status, metric, value, threshold, started_at, message
       FROM incidents ORDER BY started_at DESC LIMIT 10`);
    const { rows: projects } = await q(
      `SELECT p.id, p.name, p.environment,
              count(sp.server_id)::int AS server_count,
              count(*) FILTER (WHERE i.sev = 'critical')::int AS open_critical
       FROM projects p
       LEFT JOIN server_projects sp ON sp.project_id = p.id
       LEFT JOIN LATERAL (
         SELECT severity AS sev FROM incidents
         WHERE server_id = sp.server_id AND status IN ('firing','acknowledged') AND severity = 'critical' LIMIT 1
       ) i ON true
       WHERE p.archived_at IS NULL GROUP BY p.id ORDER BY p.name`);
    return { counts, servers, top, sparkline_24h: spark, ticker, projects };
  });
}
