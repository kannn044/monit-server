// Metric path → value extraction from one raw sample row (jsonb columns already
// parsed to JS objects by pg). Shared by the alert engine and the summary API.

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// Rate metrics (network / disk I/O)
// ---------------------------------------------------------------------------
// The agent ships cumulative counters, so a rate needs two samples. Callers
// pass the previous sample as ctx.prev; without it these metrics return null
// and the rule is skipped (never a fake zero).
export const RATE_METRICS = new Set([
  'net.rx_bps', 'net.tx_bps', 'net.errors_ps', 'net.drops_ps',
  'disk.read_bps', 'disk.write_bps', 'disk.read_iops', 'disk.write_iops', 'disk.busy_pct',
]);
// Two samples further apart than this are not "consecutive": a rate averaged
// over an outage is not a rate anyone can act on.
export const RATE_MAX_GAP_S = 300;

function rateDt(sample, prev) {
  if (!prev?.time || !sample?.time) return null;
  const dt = (new Date(sample.time) - new Date(prev.time)) / 1000;
  return dt > 0 && dt <= RATE_MAX_GAP_S ? dt : null;
}

/**
 * Per-entity counter deltas, matched by key (iface / dev) so an interface that
 * appears or disappears between samples does not distort the sum.
 * Returns null when nothing could be paired, or when any counter went
 * backwards (reboot / counter reset) — that interval has no meaningful rate.
 */
function counterDeltas(cur, prev, key, field) {
  const before = new Map(arr(prev).map((x) => [x?.[key], x]));
  const out = [];
  for (const c of arr(cur)) {
    const p = before.get(c?.[key]);
    if (!p) continue;
    const a = num(c[field]), b = num(p[field]);
    if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) continue;
    if (a < b) return null;
    out.push(a - b);
  }
  return out.length ? out : null;
}

function sumRate(cur, prev, key, fields, dt) {
  let total = 0, any = false;
  for (const f of fields) {
    const d = counterDeltas(cur, prev, key, f);
    if (d === null) continue;
    any = true;
    total += d.reduce((a, b) => a + b, 0);
  }
  return any ? total / dt : null;
}

function rateMetric(path, sample, prev) {
  const dt = rateDt(sample, prev);
  if (dt === null) return null;
  const n1 = sample.network, n0 = prev.network, d1 = sample.diskio, d0 = prev.diskio;
  switch (path) {
    case 'net.rx_bps':      return sumRate(n1, n0, 'iface', ['rx_bytes'], dt);
    case 'net.tx_bps':      return sumRate(n1, n0, 'iface', ['tx_bytes'], dt);
    case 'net.errors_ps':   return sumRate(n1, n0, 'iface', ['rx_errs', 'tx_errs'], dt);
    case 'net.drops_ps':    return sumRate(n1, n0, 'iface', ['rx_drop', 'tx_drop'], dt);
    case 'disk.read_bps':   return sumRate(d1, d0, 'dev', ['read_bytes'], dt);
    case 'disk.write_bps':  return sumRate(d1, d0, 'dev', ['write_bytes'], dt);
    case 'disk.read_iops':  return sumRate(d1, d0, 'dev', ['reads'], dt);
    case 'disk.write_iops': return sumRate(d1, d0, 'dev', ['writes'], dt);
    case 'disk.busy_pct': { // busiest single disk, like iostat %util
      const d = counterDeltas(d1, d0, 'dev', 'io_ms');
      if (!d) return null;
      return Math.min(100, (100 * Math.max(...d)) / (dt * 1000));
    }
    default: return null;
  }
}

export function extractMetric(path, sample, ctx = {}) {
  if (!sample) return null;
  if (RATE_METRICS.has(path)) return rateMetric(path, sample, ctx.prev);
  const { cpu, ram, load, disk, gpu, docker, pm2, http, databases } = sample;
  switch (path) {
    case 'cpu.total':        return num(cpu?.total);
    case 'ram.used_pct':     return num(ram?.used_pct);
    case 'ram.free_kb':      return num(ram?.free_kb);
    case 'ram.available_kb': return num(ram?.available_kb);
    case 'load.1m':          return num(load?.['1m']);
    case 'load.5m':          return num(load?.['5m']);
    case 'load.15m':         return num(load?.['15m']);
    case 'uptime_s':         return num(sample.uptime_s);
    case 'disk.used_pct': {  // worst partition
      const v = arr(disk).map((d) => num(d.used_pct)).filter((x) => x !== null);
      return v.length ? Math.max(...v) : null;
    }
    // Whole-machine storage: every real filesystem added together. The two
    // per-mount forms above answer "is any one partition full"; this answers
    // "is this box running out of space", which is what a fleet-level rule
    // wants. Judging the machine by its tightest mount fired on every host,
    // because /boot and /boot/efi are small by design and always near capacity.
    case 'disk.total_used_pct': {
      let size = 0, used = 0;
      for (const d of arr(disk)) {
        const sz = num(d.size_kb), us = num(d.used_kb);
        if (sz !== null && us !== null && sz > 0) { size += sz; used += us; }
      }
      return size > 0 ? (100 * used) / size : null;
    }
    case 'disk.total_size_kb': {
      const v = arr(disk).map((d) => num(d.size_kb)).filter((x) => x !== null && x > 0);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    }
    case 'disk.total_avail_kb': {
      const v = arr(disk).map((d) => num(d.avail_kb)).filter((x) => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    }
    case 'disk.avail_kb': {  // tightest partition
      const v = arr(disk).map((d) => num(d.avail_kb)).filter((x) => x !== null);
      return v.length ? Math.min(...v) : null;
    }
    case 'gpu.util_pct': {
      const v = arr(gpu).map((g) => num(g.util_pct)).filter((x) => x !== null);
      return v.length ? Math.max(...v) : null;
    }
    case 'gpu.mem_used_pct': {
      const v = arr(gpu)
        .map((g) => (num(g.mem_total_mb) > 0 ? (100 * num(g.mem_used_mb)) / num(g.mem_total_mb) : null))
        .filter((x) => x !== null);
      return v.length ? Math.max(...v) : null;
    }
    // accessible === false means the agent could not read the daemon at all.
    // Returning 0 there would fire "nothing is running" on a healthy host.
    case 'docker.running':   return docker?.accessible === false ? null : num(docker?.running);
    case 'pm2.online':       return pm2?.accessible === false ? null : num(pm2?.online);
    case 'http.status_code': { // worst check: any non-200 wins (returns that code)
      const checks = arr(http);
      if (!checks.length) return null;
      const bad = checks.find((c) => num(c.status_code) !== 200);
      return bad ? num(bad.status_code) : 200;
    }
    case 'http.latency_ms': {
      const v = arr(http).map((c) => num(c.latency_ms)).filter((x) => x !== null);
      return v.length ? Math.max(...v) : null;
    }
    case 'db.active_pct': {  // worst of mysql/postgres active/max
      const out = [];
      for (const k of ['mysql', 'postgres']) {
        const d = databases?.[k];
        if (d?.present && num(d.max) > 0 && d.reachable !== false) out.push((100 * num(d.active)) / num(d.max));
      }
      return out.length ? Math.max(...out) : null;
    }
    // --- MySQL NDB Cluster -------------------------------------------------
    // Every one returns null when the agent could not read the cluster, so a
    // collector that cannot see NDB never scores as "every node is down".
    case 'ndb.nodes_unhealthy':
    case 'ndb.data_nodes_started':
    case 'ndb.data_nodes_configured':
    case 'ndb.node_groups_down':
    case 'ndb.data_memory_pct':
    case 'ndb.index_memory_pct':
    case 'ndb.arbitrator_connected': {
      const c = databases?.ndb;
      if (!c?.present || c.accessible === false) return null;
      switch (path) {
        case 'ndb.nodes_unhealthy':       return num(c.unhealthy);
        case 'ndb.data_nodes_started':    return num(c.data_nodes_started);
        case 'ndb.data_nodes_configured': return num(c.data_nodes_configured);
        // Omitted by the agent when a downed node could not be attributed to a
        // node group — null skips the rule rather than reporting a false zero.
        case 'ndb.node_groups_down':      return num(c.node_groups_down);
        case 'ndb.data_memory_pct':       return num(c.data_memory_pct);
        case 'ndb.index_memory_pct':      return num(c.index_memory_pct);
        case 'ndb.arbitrator_connected':
          return c.arbitrator_connected === undefined ? null : (c.arbitrator_connected ? 1 : 0);
        default: return null;
      }
    }
    case 'db.active': {
      const out = [];
      for (const k of ['mysql', 'postgres']) {
        const d = databases?.[k];
        if (d?.present) out.push(num(d.active));
      }
      return out.length ? Math.max(...out) : null;
    }
    // service_down: count of expected services (ctx.expected) not running. > 0 fires.
    case 'service_down': {
      const expected = ctx.expected || [];
      if (!expected.length) return null;
      let down = 0;
      let checked = 0;
      for (const e of expected) {
        if (e.kind === 'docker') {
          // Unreadable ≠ down. Skip the check rather than invent an outage.
          if (docker?.accessible === false) continue;
          checked++;
          const c = arr(docker?.containers).find((x) => x.name === e.name);
          if (!c || c.state !== 'running') down++;
        } else if (e.kind === 'pm2') {
          if (pm2?.accessible === false) continue;
          checked++;
          const p = arr(pm2?.processes).find((x) => x.name === e.name);
          if (!p || p.status !== 'online') down++;
        }
      }
      return checked ? down : null;
    }
    // no_sample: seconds since last sample (computed by the caller from last_seen)
    case 'no_sample':        return ctx.noSampleSeconds ?? null;
    default:                 return null;
  }
}

export function compare(value, comparator, threshold) {
  if (value === null || value === undefined) return false;
  switch (comparator) {
    case '>':  return value > threshold;
    case '>=': return value >= threshold;
    case '<':  return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default:   return false;
  }
}

export const METRIC_UNITS = {
  'cpu.total': 'percent', 'ram.used_pct': 'percent', 'ram.free_kb': 'KB',
  'ram.available_kb': 'KB', 'disk.used_pct': 'percent', 'disk.avail_kb': 'KB',
  'disk.total_used_pct': 'percent', 'disk.total_size_kb': 'KB', 'disk.total_avail_kb': 'KB',
  'load.1m': '', 'load.5m': '', 'load.15m': '', 'uptime_s': 'seconds',
  'gpu.util_pct': 'percent', 'gpu.mem_used_pct': 'percent',
  'net.rx_bps': 'bytes/s', 'net.tx_bps': 'bytes/s',
  'net.errors_ps': 'per second', 'net.drops_ps': 'per second',
  'disk.read_bps': 'bytes/s', 'disk.write_bps': 'bytes/s',
  'disk.read_iops': 'per second', 'disk.write_iops': 'per second', 'disk.busy_pct': 'percent',
  'docker.running': 'count', 'pm2.online': 'count',
  'ndb.nodes_unhealthy': 'count', 'ndb.data_nodes_started': 'count',
  'ndb.data_nodes_configured': 'count', 'ndb.node_groups_down': 'count',
  'ndb.data_memory_pct': 'percent', 'ndb.index_memory_pct': 'percent',
  'ndb.arbitrator_connected': 'count',
  'http.status_code': 'code', 'http.latency_ms': 'ms',
  'db.active_pct': 'percent', 'db.active': 'count',
  'service_down': 'count', 'no_sample': 'seconds',
};

// Human-readable value for incident messages and notifications. Thresholds for
// bytes/s metrics are stored in bytes/s but entered and read as MB/s (1024²,
// the same base the dashboard charts use).
export function formatMetricValue(metric, v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '-';
  const unit = METRIC_UNITS[metric];
  if (unit === 'bytes/s') return `${(Number(v) / 1048576).toFixed(2)} MB/s`;
  if (unit === 'percent') return `${Number(v).toFixed(1)}%`;
  if (unit === 'per second') return `${Number(v).toFixed(2)}/s`;
  return Number(v).toFixed(2);
}
