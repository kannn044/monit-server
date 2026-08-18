export const SERIES_COLORS = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
];

export function fmt(v, unit = '') {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (unit === 'percent') return `${Number(v).toFixed(1)}%`;
  if (unit === 'bytes/s') return `${fmtBytes(v)}/s`;
  if (unit === 'KB') return fmtBytes(v * 1024);
  if (unit === 'ms') return `${Math.round(v)} ms`;
  if (unit === 'seconds') return fmtDuration(v);
  if (typeof v === 'number') return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number(v).toFixed(2).replace(/\.?0+$/, '');
  return String(v);
}

export function fmtBytes(b) {
  if (b === null || b === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtDuration(s) {
  if (s === null || s === undefined) return '—';
  s = Math.floor(Number(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function ago(t) {
  if (!t) return 'never';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 5) return 'now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(t) {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const RANGES = [
  { label: '15m', ms: 15 * 60e3 }, { label: '1h', ms: 3600e3 }, { label: '6h', ms: 6 * 3600e3 },
  { label: '24h', ms: 24 * 3600e3 }, { label: '7d', ms: 7 * 86400e3 }, { label: '30d', ms: 30 * 86400e3 },
];
