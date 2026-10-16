// Metrics a rule can watch. The optional third element is the factor between
// what the form shows and what is stored: bytes/s metrics are stored in bytes/s
// (what the agent and alert engine use) but entered and shown in MB/s, with the
// same 1024² base the charts use.
const MB = 1048576;

export const METRICS = [
  ['cpu.total', 'CPU total %'], ['ram.used_pct', 'RAM used %'], ['ram.available_kb', 'RAM available (KB)'],
  ['disk.total_used_pct', 'Disk used % (whole machine)'],
  ['disk.used_pct', 'Disk used % (worst single mount)'],
  ['disk.avail_kb', 'Disk available KB (tightest mount)'],
  ['disk.total_avail_kb', 'Disk available KB (whole machine)'],
  ['disk.read_bps', 'Disk read (MB/s)', MB], ['disk.write_bps', 'Disk write (MB/s)', MB],
  ['disk.read_iops', 'Disk read IOPS'], ['disk.write_iops', 'Disk write IOPS'],
  ['disk.busy_pct', 'Disk busy % (busiest disk)'],
  ['net.rx_bps', 'Network in / RX (MB/s)', MB], ['net.tx_bps', 'Network out / TX (MB/s)', MB],
  ['net.errors_ps', 'Network errors per second'], ['net.drops_ps', 'Network drops per second'],
  ['load.1m', 'Load 1m'], ['load.5m', 'Load 5m'], ['load.15m', 'Load 15m'],
  ['gpu.util_pct', 'GPU utilization %'], ['gpu.mem_used_pct', 'GPU VRAM used %'],
  ['docker.running', 'Docker containers running'], ['pm2.online', 'PM2 processes online'],
  ['http.status_code', 'HTTP status code'], ['http.latency_ms', 'HTTP latency (ms)'],
  ['db.active_pct', 'DB connections used %'], ['db.active', 'DB active connections'],
  ['service_down', 'Expected services down (count)'], ['no_sample', 'Seconds since last sample'],
  ['ndb.nodes_unhealthy', 'NDB data nodes not STARTED (count)'],
  ['ndb.data_nodes_started', 'NDB data nodes started (count)'],
  ['ndb.node_groups_down', 'NDB node groups with no live node'],
  ['ndb.data_memory_pct', 'NDB DataMemory used %'],
  ['ndb.index_memory_pct', 'NDB IndexMemory used %'],
  ['ndb.arbitrator_connected', 'NDB arbitrator connected (1/0)'],
];

const entry = (m) => METRICS.find((x) => x[0] === m);
export const scaleOf = (m) => entry(m)?.[2] || 1;
export const unitSuffix = (m) => (scaleOf(m) === MB ? ' MB/s' : '');

const blankish = (v) => v === '' || v === null || v === undefined;

/** stored → form value */
export function toDisplay(metric, v) {
  if (blankish(v)) return v ?? null;
  const s = scaleOf(metric);
  return s === 1 ? Number(v) : Number((Number(v) / s).toPrecision(6));
}

/** form value → stored */
export function fromDisplay(metric, v) {
  if (blankish(v)) return null;
  return Number(v) * scaleOf(metric);
}

/** "net.rx_bps > 100 MB/s" */
export function conditionText(r) {
  const th = toDisplay(r.metric, r.threshold);
  return `${r.metric} ${r.comparator} ${th ?? '—'}${unitSuffix(r.metric)}`;
}
