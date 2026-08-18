import { q, pool } from '../db/pool.js';
import { requireRole, audit, generateAgentKey, sha256 } from '../lib/auth.js';
import { computeHealth } from '../lib/health.js';
import { extractMetric } from '../lib/metrics.js';

async function serversWithHealth(filters = {}) {
  const { project, env, status } = filters;
  const vals = []; let where = 'WHERE s.archived_at IS NULL'; let i = 1;
  if (project) { where += ` AND sp.project_id = $${i++}`; vals.push(project); }
  if (env) { where += ` AND p.environment = $${i++}`; vals.push(env); }
  const { rows } = await q(
    `SELECT DISTINCT s.id, s.name, s.ip, s.os, s.last_seen, s.created_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p2.id, 'name', p2.name, 'environment', p2.environment))
         FROM server_projects sp2 JOIN projects p2 ON p2.id = sp2.project_id
         WHERE sp2.server_id = s.id AND p2.archived_at IS NULL), '[]') AS projects,
       COALESCE((SELECT array_agg(DISTINCT inc.severity) FROM incidents inc
         WHERE inc.server_id = s.id AND inc.status IN ('firing','acknowledged')), '{}') AS active_severities
     FROM servers s
     LEFT JOIN server_projects sp ON sp.server_id = s.id
     LEFT JOIN projects p ON p.id = sp.project_id
     ${where}
     ORDER BY s.name`, vals);
  let out = rows.map((r) => ({
    ...r,
    health: computeHealth({ last_seen: r.last_seen, activeSeverities: r.active_severities }),
  }));
  if (status) out = out.filter((s) => s.health === status);
  return out;
}

export default async function serverRoutes(app) {
  app.get('/api/v1/servers', { preHandler: requireRole('viewer') }, async (req) => {
    const servers = await serversWithHealth(req.query);
    return { servers };
  });

  app.post('/api/v1/servers', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['id', 'name'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' },
          name: { type: 'string', minLength: 1 },
          ip: { type: 'string' },
          project_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const { id, name, ip = null, project_ids = [] } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO servers (id, name, ip) VALUES ($1,$2,$3)', [id, name, ip || null]);
      for (const pid of project_ids) {
        await client.query('INSERT INTO server_projects (server_id, project_id) VALUES ($1,$2)', [id, pid]);
      }
      const apiKey = generateAgentKey();
      await client.query('INSERT INTO api_keys (server_id, key_hash) VALUES ($1,$2)', [id, sha256(apiKey)]);
      await client.query('COMMIT');
      await audit(req, 'server.create', 'server', id, { name });
      // The plaintext key is returned ONCE — store it in the agent config now.
      return reply.code(201).send({ server: { id, name, ip }, api_key: apiKey });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return reply.code(409).send({ title: 'Server ID already exists', status: 409 });
      throw e;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/servers/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { rows } = await q('SELECT * FROM servers WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
    const server = rows[0];
    if (!server) return reply.code(404).send({ title: 'Not found', status: 404 });
    const [{ rows: proj }, { rows: latest }, { rows: inc }, { rows: exp }] = await Promise.all([
      q(`SELECT p.id, p.name, p.environment FROM server_projects sp JOIN projects p ON p.id = sp.project_id
         WHERE sp.server_id = $1 AND p.archived_at IS NULL`, [req.params.id]),
      q('SELECT * FROM system_metrics WHERE server_id = $1 ORDER BY time DESC LIMIT 1', [req.params.id]),
      q(`SELECT severity FROM incidents WHERE server_id = $1 AND status IN ('firing','acknowledged')`, [req.params.id]),
      q('SELECT id, kind, name, enabled FROM expected_services WHERE server_id = $1 ORDER BY kind, name', [req.params.id]),
    ]);
    return {
      server: {
        ...server,
        projects: proj,
        health: computeHealth({ last_seen: server.last_seen, activeSeverities: inc.map((r) => r.severity) }),
      },
      latest_sample: latest[0] || null,
      expected_services: exp,
    };
  });

  app.get('/api/v1/servers/:id/summary', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { rows } = await q('SELECT * FROM system_metrics WHERE server_id = $1 ORDER BY time DESC LIMIT 2', [req.params.id]);
    if (!rows.length) return { summary: null };
    const s = rows[0];
    // network rate from the two most recent samples
    let net = null;
    if (rows.length === 2) {
      const dt = (new Date(s.time) - new Date(rows[1].time)) / 1000;
      if (dt > 0) {
        const sum = (row, f) => (Array.isArray(row.network) ? row.network : []).reduce((a, n) => a + (Number(n[f]) || 0), 0);
        const rx = sum(s, 'rx_bytes') - sum(rows[1], 'rx_bytes');
        const tx = sum(s, 'tx_bytes') - sum(rows[1], 'tx_bytes');
        net = { rx_bps: rx >= 0 ? rx / dt : null, tx_bps: tx >= 0 ? tx / dt : null };
      }
    }
    return {
      summary: {
        time: s.time,
        cpu_total: extractMetric('cpu.total', s),
        ram_used_pct: extractMetric('ram.used_pct', s),
        disk_used_pct: extractMetric('disk.used_pct', s),
        disk_avail_kb: extractMetric('disk.avail_kb', s),
        load_1m: extractMetric('load.1m', s),
        gpu_util_pct: extractMetric('gpu.util_pct', s),
        gpu_mem_used_pct: extractMetric('gpu.mem_used_pct', s),
        uptime_s: s.uptime_s,
        net,
        docker: s.docker, pm2: s.pm2, http: s.http, gpu: s.gpu, disk: s.disk,
        ram: s.ram, load: s.load, databases: s.databases,
      },
    };
  });

  app.patch('/api/v1/servers/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' }, ip: { type: 'string' },
          project_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const { name, ip, project_ids } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (name !== undefined || ip !== undefined) {
        await client.query(
          `UPDATE servers SET name = COALESCE($2, name), ip = COALESCE($3::inet, ip) WHERE id = $1`,
          [req.params.id, name ?? null, ip || null]);
      }
      if (project_ids !== undefined) {
        await client.query('DELETE FROM server_projects WHERE server_id = $1', [req.params.id]);
        for (const pid of project_ids) {
          await client.query('INSERT INTO server_projects (server_id, project_id) VALUES ($1,$2)', [req.params.id, pid]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await audit(req, 'server.update', 'server', req.params.id, req.body);
    return { ok: true };
  });

  app.delete('/api/v1/servers/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rowCount } = await q('UPDATE servers SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await q('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1 AND revoked_at IS NULL', [req.params.id]);
    await audit(req, 'server.archive', 'server', req.params.id);
    return { ok: true };
  });

  app.post('/api/v1/servers/:id/keys/rotate', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rows } = await q('SELECT id FROM servers WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    const apiKey = generateAgentKey();
    await q('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1 AND revoked_at IS NULL', [req.params.id]);
    await q('INSERT INTO api_keys (server_id, key_hash) VALUES ($1,$2)', [req.params.id, sha256(apiKey)]);
    await audit(req, 'key.rotate', 'server', req.params.id);
    return { api_key: apiKey }; // shown once
  });

  // ---- Expected services (drives service_down alerts) ----
  app.post('/api/v1/servers/:id/expected-services', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['kind', 'name'],
        properties: {
          kind: { type: 'string', enum: ['docker', 'pm2'] },
          name: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const { rows } = await q(
        `INSERT INTO expected_services (server_id, kind, name) VALUES ($1,$2,$3) RETURNING *`,
        [req.params.id, req.body.kind, req.body.name]);
      await audit(req, 'expected_service.create', 'server', req.params.id, req.body);
      return reply.code(201).send({ expected_service: rows[0] });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ title: 'Already exists', status: 409 });
      throw e;
    }
  });

  app.delete('/api/v1/servers/:id/expected-services/:esId', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rowCount } = await q('DELETE FROM expected_services WHERE id = $1 AND server_id = $2', [req.params.esId, req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'expected_service.delete', 'server', req.params.id, { id: req.params.esId });
    return { ok: true };
  });
}

export { serversWithHealth };
