import { q } from '../db/pool.js';
import { verifyAgentKey } from '../lib/auth.js';
import { config } from '../config.js';

// Ajv schema for the agent payload (extra properties tolerated, key fields typed)
const sampleSchema = {
  type: 'object',
  required: ['server_id', 'timestamp'],
  additionalProperties: true,
  properties: {
    server_id: { type: 'string', minLength: 1, maxLength: 128 },
    timestamp: { type: 'string', format: 'date-time' },
    hostname: { type: 'string' },
    os: { type: 'string' },
    uptime_s: { type: 'number' },
    cpu: { type: 'object' },
    ram: { type: 'object' },
    load: { type: 'object' },
    disk: { type: 'array' },
    network: { type: 'array' },
    gpu: { type: 'array' },
    docker: { type: 'object' },
    pm2: { type: 'object' },
    http: { type: 'array' },
    databases: { type: 'object' },
  },
};

// Simple in-memory per-server token bucket (per process; fronting LB should
// also rate-limit if running multiple replicas).
const buckets = new Map();
function rateLimited(serverId) {
  const now = Date.now();
  let b = buckets.get(serverId);
  if (!b || now - b.start > config.ingestRateLimit.windowMs) {
    b = { start: now, count: 0 };
    buckets.set(serverId, b);
  }
  b.count += 1;
  return b.count > config.ingestRateLimit.max;
}

export default async function ingestRoutes(app) {
  app.post('/api/v1/ingest', {
    schema: { body: sampleSchema },
    bodyLimit: config.ingestMaxBodyBytes,
    config: { rawBody: false },
  }, async (req, reply) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const key = await verifyAgentKey(token);
    if (!key || key.scope !== 'ingest') {
      return reply.code(401).send({ title: 'Invalid agent key', status: 401 });
    }
    const s = req.body;
    if (s.server_id !== key.server_id) {
      return reply.code(403).send({ title: 'server_id does not match API key', status: 403 });
    }
    if (rateLimited(s.server_id)) {
      return reply.code(429).send({ title: 'Rate limit exceeded', status: 429 });
    }

    // Reject wildly skewed timestamps (> 24h future); accept old buffered samples.
    const ts = new Date(s.timestamp);
    if (Number.isNaN(ts.getTime()) || ts.getTime() > Date.now() + 24 * 3600 * 1000) {
      return reply.code(400).send({ title: 'Invalid timestamp', status: 400 });
    }

    await q(
      `INSERT INTO system_metrics (time, server_id, cpu, ram, load, uptime_s, disk, network, gpu, docker, pm2, http, databases)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ts.toISOString(), s.server_id, s.cpu ?? null, s.ram ?? null, s.load ?? null,
       s.uptime_s ?? null, JSON.stringify(s.disk ?? []), JSON.stringify(s.network ?? []),
       JSON.stringify(s.gpu ?? []), s.docker ?? null, s.pm2 ?? null,
       JSON.stringify(s.http ?? []), s.databases ?? null]
    );

    // last_seen is "when did we last hear from this agent", so it must be OUR
    // clock, not the agent's. Using the payload timestamp compared two different
    // machines' clocks: a host whose clock ran a minute slow looked permanently
    // offline while reporting fine, and one whose clock jumped forward once had
    // last_seen pinned to that future value (GREATEST) and never advanced again.
    // Sample rows keep the agent timestamp; only liveness uses server time.
    const skewMs = Date.now() - ts.getTime();
    await q(
      `UPDATE servers SET last_seen = now(), os = COALESCE(NULLIF($2, ''), os) WHERE id = $1`,
      [s.server_id, s.os || '']
    );

    // A big gap is either clock drift or a buffered backlog being drained. Both
    // are worth knowing about, because they distort the metric charts too.
    if (Math.abs(skewMs) > 120_000) {
      req.log.warn(
        { server_id: s.server_id, skew_s: Math.round(skewMs / 1000) },
        'sample timestamp is far from server time — check NTP on the agent host (or it is draining a backlog)'
      );
    }

    return reply.code(202).send({ accepted: true });
  });
}
