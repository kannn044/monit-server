// Metric path → value extraction from one raw sample row (jsonb columns already
// parsed to JS objects by pg). Shared by the alert engine and the summary API.

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : []);

export function extractMetric(path, sample, ctx = {}) {
  if (!sample) return null;
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
    case 'docker.running':   return num(docker?.running);
    case 'pm2.online':       return num(pm2?.online);
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
      for (const e of expected) {
        if (e.kind === 'docker') {
          const c = arr(docker?.containers).find((x) => x.name === e.name);
          if (!c || c.state !== 'running') down++;
        } else if (e.kind === 'pm2') {
          const p = arr(pm2?.processes).find((x) => x.name === e.name);
          if (!p || p.status !== 'online') down++;
        }
      }
      return down;
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
  'docker.running': 'count', 'pm2.online': 'count',
  'http.status_code': 'code', 'http.latency_ms': 'ms',
  'db.active_pct': 'percent', 'db.active': 'count',
  'service_down': 'count', 'no_sample': 'seconds',
};
