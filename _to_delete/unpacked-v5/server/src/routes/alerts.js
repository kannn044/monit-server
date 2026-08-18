import { q } from '../db/pool.js';
import { requireRole, audit } from '../lib/auth.js';
import { deliver } from '../workers/channels.js';

const ruleBody = {
  type: 'object',
  required: ['name', 'metric', 'comparator', 'severity'],
  properties: {
    name: { type: 'string', minLength: 1 },
    scope_type: { type: 'string', enum: ['project', 'servers', 'all'] },
    scope_ids: { type: 'array', items: { type: 'string' } },
    metric: { type: 'string', minLength: 1 },
    comparator: { type: 'string', enum: ['>', '>=', '<', '<=', '==', '!='] },
    threshold: { type: ['number', 'null'] },
    duration_min: { type: 'number', minimum: 0 },
    recover_threshold: { type: ['number', 'null'] },
    severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
    channels: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean' },
    flap_limit: { type: 'integer', minimum: 1 },
    flap_window_min: { type: 'integer', minimum: 1 },
  },
};

export default async function alertRoutes(app) {
  // ---- Incidents ----
  app.get('/api/v1/alerts', { preHandler: requireRole('viewer') }, async (req) => {
    const vals = []; let where = `WHERE i.status IN ('firing','acknowledged','flapping','silenced')`; let n = 1;
    if (req.query.severity) { where += ` AND i.severity = $${n++}`; vals.push(req.query.severity); }
    if (req.query.project) {
      where += ` AND i.server_id IN (SELECT server_id FROM server_projects WHERE project_id = $${n++})`;
      vals.push(req.query.project);
    }
    const { rows } = await q(
      `SELECT i.*, s.name AS server_name FROM incidents i LEFT JOIN servers s ON s.id = i.server_id
       ${where} ORDER BY i.started_at DESC LIMIT 500`, vals);
    return { incidents: rows };
  });

  app.get('/api/v1/incidents', { preHandler: requireRole('viewer') }, async (req) => {
    const vals = []; const conds = []; let n = 1;
    if (req.query.status) { conds.push(`i.status = $${n++}`); vals.push(req.query.status); }
    if (req.query.severity) { conds.push(`i.severity = $${n++}`); vals.push(req.query.severity); }
    if (req.query.server) { conds.push(`i.server_id = $${n++}`); vals.push(req.query.server); }
    if (req.query.project) { conds.push(`i.server_id IN (SELECT server_id FROM server_projects WHERE project_id = $${n++})`); vals.push(req.query.project); }
    if (req.query.from) { conds.push(`i.started_at >= $${n++}`); vals.push(req.query.from); }
    if (req.query.to) { conds.push(`i.started_at <= $${n++}`); vals.push(req.query.to); }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await q(
      `SELECT i.*, s.name AS server_name FROM incidents i LEFT JOIN servers s ON s.id = i.server_id
       ${where} ORDER BY i.started_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, vals);
    return { incidents: rows, page, limit };
  });

  const setIncident = (status, extra = '') => async (req, reply) => {
    const { rows } = await q(
      `UPDATE incidents SET status = $2 ${extra}, notes = COALESCE($3, notes)
       WHERE id = $1 AND status IN ('firing','acknowledged','flapping','silenced') RETURNING *`,
      [req.params.id, status, req.body?.notes ?? null]);
    if (!rows[0]) return reply.code(404).send({ title: 'Incident not found or already resolved', status: 404 });
    await audit(req, `incident.${status}`, 'incident', req.params.id);
    return { incident: rows[0] };
  };

  app.post('/api/v1/alerts/:id/ack', { preHandler: requireRole('operator') },
    setIncident('acknowledged', ', acknowledged_at = now()'));
  app.post('/api/v1/alerts/:id/resolve', { preHandler: requireRole('operator') },
    setIncident('resolved', ', resolved_at = now()'));

  app.post('/api/v1/alerts/:id/silence', {
    preHandler: requireRole('operator'),
    schema: { body: { type: 'object', required: ['minutes'], properties: { minutes: { type: 'number', minimum: 1 } } } },
  }, async (req, reply) => {
    const { rows } = await q(
      `UPDATE incidents SET status = 'silenced', silenced_until = now() + ($2 || ' minutes')::interval
       WHERE id = $1 AND status IN ('firing','acknowledged','flapping') RETURNING *`,
      [req.params.id, String(req.body.minutes)]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'incident.silence', 'incident', req.params.id, { minutes: req.body.minutes });
    return { incident: rows[0] };
  });

  // ---- Rules ----
  app.get('/api/v1/alert-rules', { preHandler: requireRole('viewer') }, async () => {
    const { rows } = await q('SELECT * FROM alert_rules ORDER BY created_at');
    return { rules: rows };
  });

  app.post('/api/v1/alert-rules', { preHandler: requireRole('admin'), schema: { body: ruleBody } }, async (req, reply) => {
    const b = req.body;
    const { rows } = await q(
      `INSERT INTO alert_rules (name, scope_type, scope_ids, metric, comparator, threshold, duration_min,
         recover_threshold, severity, channels, enabled, flap_limit, flap_window_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [b.name, b.scope_type || 'all', b.scope_ids || [], b.metric, b.comparator, b.threshold ?? null,
       b.duration_min ?? 0, b.recover_threshold ?? null, b.severity, JSON.stringify(b.channels || []),
       b.enabled ?? true, b.flap_limit ?? 5, b.flap_window_min ?? 30]);
    await audit(req, 'rule.create', 'rule', rows[0].id, b);
    return reply.code(201).send({ rule: rows[0] });
  });

  app.put('/api/v1/alert-rules/:id', { preHandler: requireRole('admin'), schema: { body: ruleBody } }, async (req, reply) => {
    const b = req.body;
    const { rows } = await q(
      `UPDATE alert_rules SET name=$2, scope_type=$3, scope_ids=$4, metric=$5, comparator=$6, threshold=$7,
         duration_min=$8, recover_threshold=$9, severity=$10, channels=$11, enabled=$12,
         flap_limit=$13, flap_window_min=$14, updated_at=now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.name, b.scope_type || 'all', b.scope_ids || [], b.metric, b.comparator,
       b.threshold ?? null, b.duration_min ?? 0, b.recover_threshold ?? null, b.severity,
       JSON.stringify(b.channels || []), b.enabled ?? true, b.flap_limit ?? 5, b.flap_window_min ?? 30]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'rule.update', 'rule', req.params.id, b);
    return { rule: rows[0] };
  });

  app.delete('/api/v1/alert-rules/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rowCount } = await q('DELETE FROM alert_rules WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'rule.delete', 'rule', req.params.id);
    return { ok: true };
  });

  // ---- Channels ----
  app.get('/api/v1/channels', { preHandler: requireRole('viewer') }, async (req) => {
    const { rows } = await q('SELECT id, name, type, enabled, created_at, config FROM notify_channels ORDER BY name');
    // hide secrets from non-admins
    const isAdmin = req.user?.role === 'admin';
    return { channels: rows.map((c) => ({ ...c, config: isAdmin ? c.config : undefined })) };
  });

  app.post('/api/v1/channels', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['name', 'type', 'config'],
        properties: {
          name: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['telegram', 'slack', 'webhook'] },
          config: { type: 'object' },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const { rows } = await q(
        `INSERT INTO notify_channels (name, type, config, enabled) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.body.name, req.body.type, req.body.config, req.body.enabled ?? true]);
      await audit(req, 'channel.create', 'channel', rows[0].id, { name: req.body.name, type: req.body.type });
      return reply.code(201).send({ channel: rows[0] });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ title: 'Channel name already exists', status: 409 });
      throw e;
    }
  });

  app.put('/api/v1/channels/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, type, config, enabled } = req.body || {};
    const { rows } = await q(
      `UPDATE notify_channels SET name = COALESCE($2, name), type = COALESCE($3, type),
         config = COALESCE($4, config), enabled = COALESCE($5, enabled)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name ?? null, type ?? null, config ?? null, enabled ?? null]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'channel.update', 'channel', req.params.id, { name });
    return { channel: rows[0] };
  });

  app.delete('/api/v1/channels/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rowCount } = await q('DELETE FROM notify_channels WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'channel.delete', 'channel', req.params.id);
    return { ok: true };
  });

  // Send a test notification through a channel
  app.post('/api/v1/webhooks/test', {
    preHandler: requireRole('admin'),
    schema: { body: { type: 'object', required: ['channel'], properties: { channel: { type: 'string' } } } },
  }, async (req, reply) => {
    const { rows } = await q('SELECT * FROM notify_channels WHERE name = $1', [req.body.channel]);
    if (!rows[0]) return reply.code(404).send({ title: 'Channel not found', status: 404 });
    const payload = {
      event: 'test', severity: 'info', rule_name: 'Test notification',
      server_id: '-', message: `Test from monit-server at ${new Date().toISOString()}`,
    };
    try {
      const res = await deliver(rows[0], payload);
      return { ok: true, response: res };
    } catch (e) {
      return reply.code(502).send({ title: 'Delivery failed', detail: String(e.message || e), status: 502 });
    }
  });

  // Notification log
  app.get('/api/v1/notification-log', { preHandler: requireRole('viewer') }, async () => {
    const { rows } = await q('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT 200');
    return { log: rows };
  });
}
