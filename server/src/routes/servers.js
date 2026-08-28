import { q, pool } from '../db/pool.js';
import { requireRole, audit, generateAgentKey, sha256 } from '../lib/auth.js';
import { computeHealth } from '../lib/health.js';
import { extractMetric } from '../lib/metrics.js';

async function serversWithHealth(filters = {}) {
  const { project, env, status, archived } = filters;
  const vals = [];
  // `archived=only` is how the UI surfaces deleted servers so they can be
  // restored or purged — without it a soft-deleted row is invisible yet still
  // holds its primary key, which is what produced "Server ID already exists".
  let where = archived === 'only' ? 'WHERE s.archived_at IS NOT NULL'
    : archived === 'all' ? 'WHERE true'
      : 'WHERE s.archived_at IS NULL';
  let i = 1;
  if (project) { where += ` AND sp.project_id = $${i++}`; vals.push(project); }
  if (env) { where += ` AND p.environment = $${i++}`; vals.push(env); }
  const { rows } = await q(
    `SELECT DISTINCT s.id, s.name, s.ip, s.os, s.last_seen, s.created_at, s.archived_at,
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
    health: r.archived_at
      ? 'archived'
      : computeHealth({ last_seen: r.last_seen, activeSeverities: r.active_severities }),
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
      // Deleting a server archives it, so the primary key survives. Registering
      // the same id again used to hit that hidden row and fail with "Server ID
      // already exists" — which is nonsense from the operator's side, since the
      // server is gone from every screen. Re-registering now revives the row and
      // issues a fresh key. Only a *live* id is a real conflict.
      const { rows: prior } = await client.query(
        'SELECT id, archived_at FROM servers WHERE id = $1 FOR UPDATE', [id]);
      const revived = !!prior[0];
      if (revived && !prior[0].archived_at) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          title: 'Server ID already exists',
          status: 409,
          detail: `"${id}" is already registered and active. Use "New key" on that server to issue a replacement key — the old key stops working immediately.`,
        });
      }
      if (revived) {
        // Start clean: the previous life's key, alerts and evaluation state must
        // not leak into the new registration. Metrics history is kept (use
        // DELETE ?purge=1 to erase a server outright).
        await client.query(
          `UPDATE servers SET archived_at = NULL, name = $2, ip = $3::inet, last_seen = NULL WHERE id = $1`,
          [id, name, ip || null]);
        await client.query('DELETE FROM server_projects WHERE server_id = $1', [id]);
        await client.query('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1 AND revoked_at IS NULL', [id]);
        await client.query(
          `UPDATE incidents SET status = 'resolved', resolved_at = now(),
             notes = COALESCE(notes || ' | ', '') || 'auto-resolved: server re-registered'
           WHERE server_id = $1 AND status IN ('firing','acknowledged','flapping','silenced')`, [id]);
        await client.query('DELETE FROM rule_state WHERE server_id = $1', [id]);
      } else {
        await client.query('INSERT INTO servers (id, name, ip) VALUES ($1,$2,$3)', [id, name, ip || null]);
      }
      for (const pid of project_ids) {
        await client.query('INSERT INTO server_projects (server_id, project_id) VALUES ($1,$2)', [id, pid]);
      }
      const apiKey = generateAgentKey();
      await client.query('INSERT INTO api_keys (server_id, key_hash) VALUES ($1,$2)', [id, sha256(apiKey)]);
      await client.query('COMMIT');
      await audit(req, revived ? 'server.restore' : 'server.create', 'server', id, { name, revived });
      // The plaintext key is returned ONCE — store it in the agent config now.
      return reply.code(201).send({ server: { id, name, ip }, api_key: apiKey, revived });
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

  // Move many servers into one group at once. Assigning 14 hosts one modal at a
  // time is the reason grouping went unused; this is the same operation the
  // Groups page performs from a multi-select.
  //
  // A server belongs to exactly one group, so membership is REPLACED, not added
  // to. project_id: null clears it (the server moves to "Ungrouped").
  app.post('/api/v1/servers/bulk/group', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['server_ids'],
        properties: {
          server_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
          project_id: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { server_ids, project_id = null } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (project_id) {
        const { rows } = await client.query(
          'SELECT id FROM projects WHERE id = $1 AND archived_at IS NULL', [project_id]);
        if (!rows[0]) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ title: 'Group not found', status: 404 });
        }
      }
      const { rows: found } = await client.query(
        'SELECT id FROM servers WHERE id = ANY($1) AND archived_at IS NULL', [server_ids]);
      const ids = found.map((r) => r.id);
      if (!ids.length) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ title: 'No matching servers', status: 404 });
      }
      await client.query('DELETE FROM server_projects WHERE server_id = ANY($1)', [ids]);
      if (project_id) {
        await client.query(
          `INSERT INTO server_projects (server_id, project_id)
           SELECT unnest($1::text[]), $2`, [ids, project_id]);
      }
      await client.query('COMMIT');
      await audit(req, 'server.group', 'group', project_id || '(none)', { servers: ids.length });
      return { updated: ids.length, project_id };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
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

  // DELETE            -> archive: hidden everywhere, key revoked, history kept,
  //                      and the id can be registered again (see POST above).
  // DELETE ?purge=1   -> erase: the row, its keys, projects links, expected
  //                      services, incidents and every stored sample are gone.
  app.delete('/api/v1/servers/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = req.params.id;
    const purge = ['1', 'true', 'yes'].includes(String(req.query.purge ?? '').toLowerCase());

    if (purge) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT id FROM servers WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) { await client.query('ROLLBACK'); return reply.code(404).send({ title: 'Not found', status: 404 }); }
        // system_metrics and rule_state carry server_id without a foreign key
        // (the metrics table is a hypertable under TimescaleDB, which cannot
        // take one), so they are cleared explicitly. Everything else cascades.
        const { rowCount: samples } = await client.query('DELETE FROM system_metrics WHERE server_id = $1', [id]);
        await client.query('DELETE FROM rule_state WHERE server_id = $1', [id]);
        await client.query('DELETE FROM servers WHERE id = $1', [id]);
        await client.query('COMMIT');
        await audit(req, 'server.purge', 'server', id, { samples_deleted: samples });
        return { ok: true, purged: true, samples_deleted: samples };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    const { rowCount } = await q('UPDATE servers SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await q('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1 AND revoked_at IS NULL', [id]);
    await q(`UPDATE incidents SET status = 'resolved', resolved_at = now(),
               notes = COALESCE(notes || ' | ', '') || 'auto-resolved: server archived'
             WHERE server_id = $1 AND status IN ('firing','acknowledged','flapping','silenced')`, [id]);
    await q('DELETE FROM rule_state WHERE server_id = $1', [id]);
    await audit(req, 'server.archive', 'server', id);
    return { ok: true, purged: false };
  });

  // Bring an archived server back without retyping its details. A new key is
  // issued because the old one was revoked on archive and is unrecoverable.
  app.post('/api/v1/servers/:id/restore', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = req.params.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT id, archived_at FROM servers WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return reply.code(404).send({ title: 'Not found', status: 404 }); }
      if (!rows[0].archived_at) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ title: 'Server is not archived', status: 409 });
      }
      await client.query('UPDATE servers SET archived_at = NULL, last_seen = NULL WHERE id = $1', [id]);
      await client.query('UPDATE api_keys SET revoked_at = now() WHERE server_id = $1 AND revoked_at IS NULL', [id]);
      const apiKey = generateAgentKey();
      await client.query('INSERT INTO api_keys (server_id, key_hash) VALUES ($1,$2)', [id, sha256(apiKey)]);
      await client.query('DELETE FROM rule_state WHERE server_id = $1', [id]);
      await client.query('COMMIT');
      await audit(req, 'server.restore', 'server', id);
      return { api_key: apiKey }; // shown once
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
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
