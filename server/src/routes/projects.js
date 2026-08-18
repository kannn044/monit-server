import { q } from '../db/pool.js';
import { requireRole, audit } from '../lib/auth.js';
import { serversWithHealth } from './servers.js';

export default async function projectRoutes(app) {
  app.get('/api/v1/projects', { preHandler: requireRole('viewer') }, async () => {
    const { rows } = await q(
      `SELECT p.*, COALESCE(c.n, 0)::int AS server_count
       FROM projects p
       LEFT JOIN (SELECT project_id, count(*) AS n FROM server_projects GROUP BY project_id) c ON c.project_id = p.id
       WHERE p.archived_at IS NULL ORDER BY p.name`);
    return { projects: rows };
  });

  app.post('/api/v1/projects', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['name'],
        properties: { name: { type: 'string', minLength: 1 }, environment: { type: 'string', minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    try {
      const { rows } = await q(
        'INSERT INTO projects (name, environment) VALUES ($1,$2) RETURNING *',
        [req.body.name, req.body.environment || 'Dev']);
      await audit(req, 'project.create', 'project', rows[0].id, req.body);
      return reply.code(201).send({ project: rows[0] });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ title: 'Project name already exists', status: 409 });
      throw e;
    }
  });

  app.put('/api/v1/projects/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 }, environment: { type: 'string', minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    const { rows } = await q(
      `UPDATE projects SET name = COALESCE($2, name), environment = COALESCE($3, environment)
       WHERE id = $1 AND archived_at IS NULL RETURNING *`,
      [req.params.id, req.body.name ?? null, req.body.environment ?? null]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'project.update', 'project', req.params.id, req.body);
    return { project: rows[0] };
  });

  app.delete('/api/v1/projects/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rowCount } = await q('UPDATE projects SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'project.archive', 'project', req.params.id);
    return { ok: true };
  });

  app.get('/api/v1/projects/:id/overview', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { rows } = await q('SELECT * FROM projects WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    const servers = await serversWithHealth({ project: req.params.id });
    const ids = servers.map((s) => s.id);
    let avg = { cpu: null, ram: null };
    if (ids.length) {
      const { rows: a } = await q(
        `SELECT avg(cpu_total_pct) AS cpu, avg(ram_used_pct) AS ram
         FROM metrics_1m WHERE server_id = ANY($1) AND bucket > now() - INTERVAL '15 minutes'`, [ids]);
      avg = { cpu: a[0].cpu === null ? null : Number(a[0].cpu), ram: a[0].ram === null ? null : Number(a[0].ram) };
    }
    const { rows: inc } = await q(
      `SELECT count(*)::int AS n FROM incidents
       WHERE server_id = ANY($1) AND status IN ('firing','acknowledged') AND severity = 'critical'`, [ids.length ? ids : ['-']]);
    return {
      project: rows[0],
      servers,
      counts: {
        total: servers.length,
        online: servers.filter((s) => s.health === 'online').length,
        offline: servers.filter((s) => s.health === 'offline').length,
        critical: servers.filter((s) => s.health === 'critical').length,
        warning: servers.filter((s) => s.health === 'warning').length,
        open_critical_incidents: inc[0].n,
      },
      avg_15m: avg,
    };
  });
}
