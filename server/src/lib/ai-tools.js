// The read-only tool surface the model is allowed to reach for.
//
// One module, two consumers: the chat agent loop in routes/chat.js, and
// (later) an MCP endpoint. Keeping the definitions and the executors together
// is what makes that possible — a tool is its schema plus the function, and
// neither is useful without the other.
//
// Every tool returns *text*, not JSON. A small model reads a dense line far
// more reliably than it reads nested objects, and text keeps the tool result
// cheap enough to leave in the transcript for the rest of the conversation.

import { q, pool } from '../db/pool.js';
import { config } from '../config.js';
import { serverDetail, incidentLine, ndbSummary, fleetLine } from './ai-analytics.js';

const MAX_CHARS = 6000;   // one tool result must never eat the context window
const clip = (s) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (truncated)` : s);

/**
 * Resolve whatever the model typed to a real server.
 * It will use the display name, the id, the hostname, or a fragment of any of
 * them, and being strict about it just produces "server not found" for a
 * server that is plainly there.
 */
function findServer(snap, needle) {
  if (!needle) return null;
  const n = String(needle).trim().toLowerCase();
  return snap.list.find((s) => s.id.toLowerCase() === n)
    || snap.list.find((s) => s.name.toLowerCase() === n)
    || snap.list.find((s) => s.name.toLowerCase().includes(n) || s.id.toLowerCase().includes(n))
    || null;
}

/** Windows are given by the model as free text; accept the obvious spellings. */
function parseWindow(w, fallback = '24 hours') {
  if (!w) return fallback;
  const m = String(w).trim().match(/^(\d+)\s*(m|min|minute|h|hour|d|day|w|week)s?$/i);
  if (!m) return fallback;
  const n = Math.min(Number(m[1]), 90);
  const u = m[2].toLowerCase();
  if (u.startsWith('m')) return `${Math.max(n, 1)} minutes`;
  if (u.startsWith('h')) return `${n} hours`;
  if (u.startsWith('w')) return `${n * 7} days`;
  return `${n} days`;
}

/** Metric name → rollup column. Anything not here is not queryable as a series. */
const SERIES_COLUMNS = {
  'cpu.total': 'cpu_total_pct',
  'cpu.max': 'cpu_max_pct',
  'ram.used_pct': 'ram_used_pct',
  'ram.available_kb': 'ram_available_kb',
  'load.1m': 'load_1m',
  'load.5m': 'load_5m',
  'disk.used_pct': 'disk_used_pct',
  'disk.avail_kb': 'disk_avail_kb',
  'gpu.util_pct': 'gpu_util_pct',
  'gpu.mem_used_pct': 'gpu_mem_used_pct',
};

// ---------------------------------------------------------------------------
// run_sql guard
// ---------------------------------------------------------------------------

const SQL_DENY = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|analyze|reindex|call|do|set|reset|listen|notify|begin|commit|rollback|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_sleep|dblink|lo_import|lo_export|pg_terminate_backend|pg_cancel_backend)\b/i;

const SQL_TABLES = [
  'servers', 'projects', 'server_projects', 'incidents', 'alert_rules', 'rule_state',
  'expected_services', 'notification_log', 'notification_dead_letter', 'audit_log',
  'system_metrics', 'metrics_1m', 'metrics_1h',
];

/**
 * Let the model write SQL, but only the shape of SQL that cannot do harm.
 *
 * The checks are deliberately blunt and layered, because a clever bypass of any
 * one of them still has to get past the others: a single statement, starting
 * with SELECT or WITH, no writing or system-function keyword anywhere in it, a
 * hard LIMIT bolted on, and a statement timeout set on the connection. The real
 * backstop is the database role — see docs/AI-CHAT.md — since nothing written
 * in JavaScript can be trusted alone against a determined prompt injection.
 */
async function runSql(sql, log) {
  let s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) return 'error: empty query';
  if (s.includes(';')) return 'error: only one statement is allowed';
  if (!/^(select|with)\b/i.test(s)) return 'error: only SELECT (or WITH … SELECT) is allowed';
  if (SQL_DENY.test(s)) return 'error: this query uses a keyword that is not allowed for read-only access';
  if (!SQL_TABLES.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(s))) {
    return `error: the query must read one of: ${SQL_TABLES.join(', ')}`;
  }
  if (!/\blimit\s+\d+/i.test(s)) s += ' LIMIT 200';

  const client = await pool.connect();
  try {
    // Read-only for this transaction whatever the role is allowed to do, and a
    // hard stop so a cartesian join cannot pin the database for the fleet.
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${config.aiSqlTimeoutMs}ms'`);
    const { rows, fields } = await client.query(s);
    await client.query('ROLLBACK');
    if (!rows.length) return 'query returned 0 rows';
    const cols = fields.map((f) => f.name);
    const head = cols.join(' | ');
    const body = rows.slice(0, 60)
      .map((r) => cols.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
        return String(v).slice(0, 120);
      }).join(' | '))
      .join('\n');
    return clip(`${rows.length} row(s)\n${head}\n${'-'.repeat(head.length)}\n${body}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log?.warn({ sql: s.slice(0, 200) }, 'ai run_sql failed');
    return `error: ${e.message}`;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

/**
 * Each entry: the OpenAI-shaped schema the model sees, plus run().
 * `admin: true` keeps a tool out of the schema list entirely for lower roles,
 * so a viewer's model is never even told it exists.
 */
export const TOOLS = {
  list_servers: {
    admin: false,
    schema: {
      name: 'list_servers',
      description: 'List servers with their current health and headline metrics. Use this first for any fleet-wide question.',
      parameters: {
        type: 'object',
        properties: {
          health: { type: 'string', enum: ['online', 'warning', 'critical', 'offline'], description: 'Only servers in this state.' },
          name_contains: { type: 'string', description: 'Only servers whose name contains this text.' },
        },
      },
    },
    run: async (args, { snap }) => {
      let list = snap.list;
      if (args.health) list = list.filter((s) => s.health === args.health);
      if (args.name_contains) {
        const n = String(args.name_contains).toLowerCase();
        list = list.filter((s) => s.name.toLowerCase().includes(n));
      }
      if (!list.length) return 'no servers match';
      return clip(`${list.length} server(s):\n${list.map(fleetLine).join('\n')}`);
    },
  },

  get_server_detail: {
    admin: false,
    schema: {
      name: 'get_server_detail',
      description: 'Full current state of one server: cpu/ram/disk/load with 24h and 7d percentiles, trends, disk-full projection, services, databases, NDB cluster and active incidents.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Server name or id.' } },
        required: ['server'],
      },
    },
    run: async (args, { snap }) => {
      const s = findServer(snap, args.server);
      if (!s) return `no server matches "${args.server}". Known: ${snap.list.map((x) => x.name).join(', ')}`;
      return clip(serverDetail(s));
    },
  },

  query_metrics: {
    admin: false,
    schema: {
      name: 'query_metrics',
      description: 'Time series for a metric over a window, already downsampled and summarised. Use for "when did it start", "is it rising", "compare these servers".',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: Object.keys(SERIES_COLUMNS) },
          servers: { type: 'array', items: { type: 'string' }, description: 'Server names or ids. Omit for all.' },
          window: { type: 'string', description: 'e.g. "6h", "24h", "7d". Default 24h.' },
        },
        required: ['metric'],
      },
    },
    run: async (args, { snap }) => {
      const col = SERIES_COLUMNS[args.metric];
      if (!col) return `unknown metric. Available: ${Object.keys(SERIES_COLUMNS).join(', ')}`;
      const win = parseWindow(args.window, '24 hours');
      const hours = /minute/.test(win) ? 0 : Number(win.split(' ')[0]) * (/day/.test(win) ? 24 : 1);
      // 1-minute buckets stay readable up to about six hours; past that the
      // hourly rollup says the same thing in a tenth of the rows.
      const view = hours > 6 ? 'metrics_1h' : 'metrics_1m';

      const ids = (args.servers || []).map((n) => findServer(snap, n)?.id).filter(Boolean);
      const params = [];
      let where = `bucket > now() - interval '${win}'`;
      if (ids.length) { params.push(ids); where += ` AND server_id = ANY($${params.length})`; }

      const { rows } = await q(
        `SELECT server_id, bucket, ${col} AS v FROM ${view}
          WHERE ${where} AND ${col} IS NOT NULL
          ORDER BY server_id, bucket`, params);
      if (!rows.length) return `no data for ${args.metric} in the last ${win}`;

      const bySrv = {};
      for (const r of rows) (bySrv[r.server_id] ||= []).push(r);
      const out = [`${args.metric} over the last ${win} (source: ${view})`];
      for (const [id, series] of Object.entries(bySrv)) {
        const name = snap.byId[id]?.name || id;
        const vals = series.map((r) => Number(r.v));
        const min = Math.min(...vals), max = Math.max(...vals);
        const first = vals[0], last = vals[vals.length - 1];
        const peak = series[vals.indexOf(max)];
        // At most 24 points: enough to see a shape, few enough to stay cheap.
        const step = Math.max(1, Math.ceil(series.length / 24));
        const pts = series.filter((_, i) => i % step === 0)
          .map((r) => `${new Date(r.bucket).toISOString().slice(5, 16)}=${Math.round(Number(r.v) * 10) / 10}`);
        out.push(`- ${name}: first=${Math.round(first * 10) / 10} last=${Math.round(last * 10) / 10} `
          + `min=${Math.round(min * 10) / 10} max=${Math.round(max * 10) / 10} `
          + `peak_at=${new Date(peak.bucket).toISOString().slice(0, 16)} n=${series.length}`);
        out.push(`  ${pts.join(' ')}`);
      }
      return clip(out.join('\n'));
    },
  },

  get_incidents: {
    admin: false,
    schema: {
      name: 'get_incidents',
      description: 'Incidents, open or historical. Omit status for currently open ones.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['firing', 'acknowledged', 'resolved', 'flapping', 'silenced', 'any'] },
          server: { type: 'string' },
          since_hours: { type: 'number', description: 'Look back this many hours. Default 24 for history.' },
          limit: { type: 'number' },
        },
      },
    },
    run: async (args, { snap }) => {
      const params = [];
      const where = [];
      if (args.status && args.status !== 'any') { params.push(args.status); where.push(`i.status = $${params.length}`); }
      else if (!args.since_hours) where.push(`i.status IN ('firing','acknowledged')`);
      if (args.server) {
        const s = findServer(snap, args.server);
        if (!s) return `no server matches "${args.server}"`;
        params.push(s.id); where.push(`i.server_id = $${params.length}`);
      }
      if (args.since_hours) {
        params.push(Math.min(Number(args.since_hours) || 24, 24 * 90));
        where.push(`i.started_at > now() - ($${params.length}::int * interval '1 hour')`);
      }
      params.push(Math.min(Number(args.limit) || 40, 100));
      const { rows } = await q(
        `SELECT i.id, i.server_id, i.severity, i.status, i.rule_name, i.metric,
                r.comparator, i.threshold, i.value, i.message, i.started_at, i.resolved_at, i.notes
           FROM incidents i LEFT JOIN alert_rules r ON r.id = i.rule_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY i.started_at DESC LIMIT $${params.length}`, params);
      if (!rows.length) return 'no incidents match';
      return clip(`${rows.length} incident(s):\n${rows.map((i) => `- ${incidentLine(i)}`
        + (i.resolved_at ? ` [resolved after ${Math.round((new Date(i.resolved_at) - new Date(i.started_at)) / 60000)}m]` : '')
        + (i.notes ? `\n  notes: ${i.notes}` : '')).join('\n')}`);
    },
  },

  get_incident_history: {
    admin: false,
    schema: {
      name: 'get_incident_history',
      description: 'Has this happened before? Past incidents with the same metric (and optionally the same server), with how long each took to resolve and any notes left behind.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', description: 'e.g. ram.used_pct, ndb.nodes_unhealthy' },
          server: { type: 'string' },
          days: { type: 'number', description: 'Default 90.' },
        },
      },
    },
    run: async (args, { snap }) => {
      const params = [Math.min(Number(args.days) || 90, 730)];
      const where = [`i.started_at > now() - ($1::int * interval '1 day')`];
      if (args.metric) { params.push(args.metric); where.push(`i.metric = $${params.length}`); }
      if (args.server) {
        const s = findServer(snap, args.server);
        if (s) { params.push(s.id); where.push(`i.server_id = $${params.length}`); }
      }
      const { rows } = await q(
        `SELECT i.metric, i.server_id, i.severity, i.rule_name, count(*)::int AS times,
                max(i.started_at) AS last_at,
                avg(extract(epoch FROM (i.resolved_at - i.started_at))/60)
                  FILTER (WHERE i.resolved_at IS NOT NULL) AS avg_minutes,
                (array_agg(i.notes ORDER BY i.started_at DESC)
                   FILTER (WHERE i.notes IS NOT NULL AND i.notes <> ''))[1] AS last_note
           FROM incidents i
          WHERE ${where.join(' AND ')}
          GROUP BY i.metric, i.server_id, i.severity, i.rule_name
          ORDER BY times DESC LIMIT 25`, params);
      if (!rows.length) return 'no matching incidents in that period — this looks like a first occurrence';
      return clip(rows.map((r) => `- ${snap.byId[r.server_id]?.name || r.server_id} · ${r.metric || 'n/a'} · `
        + `rule "${r.rule_name}" · ${r.times}x · last ${new Date(r.last_at).toISOString().slice(0, 16)}`
        + (r.avg_minutes ? ` · avg time to resolve ${Math.round(r.avg_minutes)}m` : ' · never resolved')
        + (r.last_note ? `\n  last note: ${r.last_note}` : '')).join('\n'));
    },
  },

  get_ndb_topology: {
    admin: false,
    schema: {
      name: 'get_ndb_topology',
      description: 'MySQL NDB Cluster layout as last reported: every node with its id, type, host, status and node group, plus arbitrator and data/index memory.',
      parameters: { type: 'object', properties: { server: { type: 'string', description: 'Omit to get every host that sees a cluster.' } } },
    },
    run: async (args, { snap }) => {
      const hosts = snap.list.filter((s) => s.ndb?.present
        && (!args.server || s.id === findServer(snap, args.server)?.id));
      if (!hosts.length) return 'no server is reporting an NDB cluster. The agent collects it only when MONIT_NDB is enabled and ndbinfo or ndb_mgm is reachable.';
      return clip(hosts.map((s) => `From ${s.name}:\n${ndbSummary(s.ndb)}`).join('\n\n'));
    },
  },

  get_services: {
    admin: false,
    schema: {
      name: 'get_services',
      description: 'PM2 processes and Docker containers on a server, compared against what is expected to be running.',
      parameters: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] },
    },
    run: async (args, { snap }) => {
      const s = findServer(snap, args.server);
      if (!s) return `no server matches "${args.server}"`;
      const out = [`${s.name}:`];
      const pm2 = s.sample?.pm2, dk = s.sample?.docker;
      out.push(pm2?.present
        ? `pm2 ${pm2.online} online / ${pm2.stopped} stopped: ${(pm2.processes || []).map((p) => `${p.name}[${p.status}]`).join(', ') || '(names unavailable — jq is not installed on that host)'}`
        : 'pm2: not present');
      out.push(dk?.present
        ? `docker ${dk.running}/${dk.total} running, ${dk.exited} exited: ${(dk.containers || []).map((c) => `${c.name || c.names}[${c.state || c.status}]`).join(', ')}`
        : 'docker: not present');
      out.push(s.expected.length
        ? `expected: ${s.expected.map((e) => `${e.kind}[${e.name}]`).join(', ')}`
        : 'expected: nothing declared (so nothing can be reported as missing)');
      if (s.missingServices.length) out.push(`NOT RUNNING: ${s.missingServices.join(', ')}`);
      return clip(out.join('\n'));
    },
  },

  get_alert_rules: {
    admin: false,
    schema: {
      name: 'get_alert_rules',
      description: 'Alert rules with their thresholds, plus how often each has fired lately — use this to judge whether a threshold is well chosen.',
      parameters: { type: 'object', properties: { days: { type: 'number', description: 'Firing window, default 30.' } } },
    },
    run: async (args) => {
      const days = Math.min(Number(args.days) || 30, 365);
      const { rows } = await q(
        `SELECT r.name, r.metric, r.comparator, r.threshold, r.recover_threshold, r.duration_min,
                r.severity, r.enabled, r.scope_type, r.channels,
                (SELECT count(*)::int FROM incidents i
                  WHERE i.rule_id = r.id AND i.started_at > now() - ($1::int * interval '1 day')) AS fired,
                (SELECT count(*)::int FROM incidents i
                  WHERE i.rule_id = r.id AND i.status = 'flapping'
                    AND i.started_at > now() - ($1::int * interval '1 day')) AS flapped
           FROM alert_rules r ORDER BY fired DESC, r.name`, [days]);
      return clip(`alert rules (firing counts over ${days} days):\n${rows.map((r) => `- "${r.name}" ${r.metric} ${r.comparator} ${r.threshold}`
        + (r.recover_threshold != null ? ` (recover ${r.recover_threshold})` : '')
        + ` for ${r.duration_min}min · ${r.severity} · ${r.enabled ? 'enabled' : 'DISABLED'}`
        + ` · scope=${r.scope_type} · channels=${JSON.stringify(r.channels)}`
        + ` · fired ${r.fired}x${r.flapped ? `, flapped ${r.flapped}x` : ''}`).join('\n')}`);
    },
  },

  get_notification_stats: {
    admin: false,
    schema: {
      name: 'get_notification_stats',
      description: 'Notification delivery success and failure per channel, and anything in the dead-letter table.',
      parameters: { type: 'object', properties: { days: { type: 'number' } } },
    },
    run: async (args) => {
      const days = Math.min(Number(args.days) || 7, 90);
      const [{ rows: log }, { rows: dead }] = await Promise.all([
        q(`SELECT channel, event, success, count(*)::int AS n FROM notification_log
            WHERE created_at > now() - ($1::int * interval '1 day')
            GROUP BY channel, event, success ORDER BY n DESC`, [days]),
        q(`SELECT channel, count(*)::int AS n, max(error) AS last_error FROM notification_dead_letter
            WHERE created_at > now() - ($1::int * interval '1 day') GROUP BY channel`, [days]),
      ]);
      const a = log.length
        ? log.map((r) => `- ${r.channel} ${r.event} ${r.success ? 'ok' : 'FAILED'} ${r.n}x`).join('\n')
        : 'no notifications sent in that period';
      const b = dead.length
        ? `\ndead letters:\n${dead.map((r) => `- ${r.channel} ${r.n}x — ${r.last_error}`).join('\n')}`
        : '';
      return clip(`notifications over ${days} days:\n${a}${b}`);
    },
  },

  correlate: {
    admin: false,
    schema: {
      name: 'correlate',
      description: 'Which servers moved together. Returns the servers whose metric rose most in a window, so a shared cause can be told apart from one sick host.',
      parameters: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: Object.keys(SERIES_COLUMNS) },
          window: { type: 'string', description: 'e.g. "3h". Default 3h.' },
        },
        required: ['metric'],
      },
    },
    run: async (args, { snap }) => {
      const col = SERIES_COLUMNS[args.metric];
      if (!col) return `unknown metric. Available: ${Object.keys(SERIES_COLUMNS).join(', ')}`;
      const win = parseWindow(args.window, '3 hours');
      const { rows } = await q(
        `WITH w AS (
           SELECT server_id, bucket, ${col} AS v FROM metrics_1m
            WHERE bucket > now() - interval '${win}' AND ${col} IS NOT NULL
         ), f AS (
           SELECT server_id,
                  (array_agg(v ORDER BY bucket))[1]                       AS first_v,
                  (array_agg(v ORDER BY bucket DESC))[1]                  AS last_v,
                  max(v) AS max_v, avg(v) AS avg_v,
                  (array_agg(bucket ORDER BY v DESC))[1]                  AS peak_at
             FROM w GROUP BY server_id
         )
         SELECT * FROM f ORDER BY (last_v - first_v) DESC NULLS LAST LIMIT 15`);
      if (!rows.length) return `no 1-minute data for ${args.metric} in the last ${win}`;
      return clip(`${args.metric} change over the last ${win}, biggest rise first:\n`
        + rows.map((r) => `- ${snap.byId[r.server_id]?.name || r.server_id}: `
          + `${Math.round(r.first_v * 10) / 10} → ${Math.round(r.last_v * 10) / 10} `
          + `(Δ${Math.round((r.last_v - r.first_v) * 10) / 10}, peak ${Math.round(r.max_v * 10) / 10} `
          + `at ${new Date(r.peak_at).toISOString().slice(11, 16)})`).join('\n')
        + '\nServers peaking within a few minutes of each other point at a shared cause rather than a local one.');
    },
  },

  run_sql: {
    admin: true,
    schema: {
      name: 'run_sql',
      description: 'Run one read-only SELECT against the monitoring database when no other tool can answer the question. '
        + `Tables: ${SQL_TABLES.join(', ')}. system_metrics has jsonb columns cpu, ram, load, disk, network, gpu, docker, pm2, http, databases. `
        + 'metrics_1m/metrics_1h have bucket, server_id, cpu_total_pct, cpu_max_pct, ram_used_pct, ram_free_kb, ram_available_kb, load_1m/5m/15m, cores, uptime_s, disk_used_pct, disk_avail_kb, gpu_util_pct, gpu_mem_used_pct, net_rx_bytes, net_tx_bytes. '
        + 'Always constrain by time.',
      parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    },
    run: async (args, { log }) => runSql(args.sql, log),
  },
};

/** Tool schemas this role may see, in OpenAI function-calling shape. */
export function toolSchemas(role) {
  const allowSql = config.aiAllowSql && role === 'admin';
  return Object.entries(TOOLS)
    .filter(([name, t]) => (t.admin ? (name === 'run_sql' ? allowSql : role === 'admin') : true))
    .map(([, t]) => ({ type: 'function', function: t.schema }));
}

export function toolNames(role) {
  return toolSchemas(role).map((t) => t.function.name);
}

/** Execute one tool call. Never throws — the model has to see the failure. */
export async function runTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return `error: no tool named "${name}"`;
  if (tool.admin && ctx.role !== 'admin') return 'error: that tool requires the admin role';
  if (name === 'run_sql' && !config.aiAllowSql) return 'error: run_sql is disabled on this installation (AI_ALLOW_SQL is not set)';
  try {
    return await tool.run(args || {}, ctx);
  } catch (e) {
    ctx.log?.warn(e, `ai tool ${name} failed`);
    return `error running ${name}: ${e.message}`;
  }
}
