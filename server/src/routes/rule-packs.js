// Rule packs: define a set of rules once, apply it to groups of servers.
// See lib/rule-packs.js for how a pack becomes ordinary alert_rules rows.
import { q } from '../db/pool.js';
import { requireRole, audit } from '../lib/auth.js';
import { syncBinding, syncPack, resolveIncidentsFor } from '../lib/rule-packs.js';

const COMPARATORS = ['>', '>=', '<', '<=', '==', '!='];
const SEVERITIES = ['critical', 'warning', 'info'];

const itemSchema = {
  type: 'object',
  required: ['name', 'metric', 'comparator', 'severity'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string', minLength: 1 },
    metric: { type: 'string', minLength: 1 },
    comparator: { type: 'string', enum: COMPARATORS },
    threshold: { type: ['number', 'null'] },
    duration_min: { type: 'number', minimum: 0 },
    recover_threshold: { type: ['number', 'null'] },
    severity: { type: 'string', enum: SEVERITIES },
    flap_limit: { type: 'integer', minimum: 1 },
    flap_window_min: { type: 'integer', minimum: 1 },
  },
};

const packSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    items: { type: 'array', items: itemSchema },
  },
};

const overrideSchema = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: {
      threshold: { type: ['number', 'null'] },
      recover_threshold: { type: ['number', 'null'] },
      duration_min: { type: ['number', 'null'], minimum: 0 },
      severity: { type: ['string', 'null'], enum: [...SEVERITIES, null] },
      enabled: { type: 'boolean' },
    },
  },
};

const bindingProps = {
  scope_type: { type: 'string', enum: ['project', 'servers', 'all'] },
  scope_ids: { type: 'array', items: { type: 'string' } },
  channels: { type: 'array', items: { type: 'string' } },
  overrides: overrideSchema,
  enabled: { type: 'boolean' },
};

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function upsertItems(packId, items) {
  const { rows: existing } = await q('SELECT id FROM rule_pack_items WHERE pack_id = $1', [packId]);
  const keep = new Set();
  let sort = 0;
  for (const it of items) {
    sort += 1;
    const vals = [it.name, it.metric, it.comparator, it.threshold ?? null, it.duration_min ?? 0,
      it.recover_threshold ?? null, it.severity, it.flap_limit ?? 5, it.flap_window_min ?? 30, sort];
    if (isUuid(it.id) && existing.some((e) => e.id === it.id)) {
      await q(
        `UPDATE rule_pack_items SET name=$2, metric=$3, comparator=$4, threshold=$5, duration_min=$6,
           recover_threshold=$7, severity=$8, flap_limit=$9, flap_window_min=$10, sort=$11
         WHERE id = $1 AND pack_id = $12`, [it.id, ...vals, packId]);
      keep.add(it.id);
    } else {
      const { rows } = await q(
        `INSERT INTO rule_pack_items (name, metric, comparator, threshold, duration_min, recover_threshold,
           severity, flap_limit, flap_window_min, sort, pack_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [...vals, packId]);
      keep.add(rows[0].id);
    }
  }
  const gone = existing.map((e) => e.id).filter((id) => !keep.has(id));
  if (gone.length) {
    await resolveIncidentsFor('pack_item_id = ANY($1::uuid[])', [gone], 'auto-resolved: rule removed from its pack');
    await q('DELETE FROM rule_pack_items WHERE id = ANY($1::uuid[])', [gone]);
  }
}

async function loadPacks(where = '', params = []) {
  const { rows: packs } = await q(`SELECT * FROM rule_packs ${where} ORDER BY name`, params);
  if (!packs.length) return [];
  const ids = packs.map((p) => p.id);
  const [{ rows: items }, { rows: bindings }] = await Promise.all([
    q('SELECT * FROM rule_pack_items WHERE pack_id = ANY($1::uuid[]) ORDER BY sort, name', [ids]),
    q(`SELECT b.*, (SELECT count(*)::int FROM alert_rules r WHERE r.pack_binding_id = b.id) AS rule_count,
              (SELECT count(*)::int FROM incidents i JOIN alert_rules r ON r.id = i.rule_id
                WHERE r.pack_binding_id = b.id AND i.status IN ('firing','acknowledged','flapping')) AS open_incidents
       FROM rule_pack_bindings b WHERE b.pack_id = ANY($1::uuid[]) ORDER BY b.created_at`, [ids]),
  ]);
  return packs.map((p) => ({
    ...p,
    items: items.filter((i) => i.pack_id === p.id),
    bindings: bindings.filter((b) => b.pack_id === p.id),
  }));
}

export default async function rulePackRoutes(app) {
  app.get('/api/v1/rule-packs', { preHandler: requireRole('viewer') }, async () => ({ packs: await loadPacks() }));

  app.post('/api/v1/rule-packs', { preHandler: requireRole('admin'), schema: { body: packSchema } }, async (req, reply) => {
    const b = req.body;
    try {
      const { rows } = await q('INSERT INTO rule_packs (name, description) VALUES ($1,$2) RETURNING *',
        [b.name, b.description || '']);
      await upsertItems(rows[0].id, b.items || []);
      await audit(req, 'rulepack.create', 'rule_pack', rows[0].id, b);
      return reply.code(201).send({ pack: (await loadPacks('WHERE id = $1', [rows[0].id]))[0] });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ title: 'A pack with that name already exists', status: 409 });
      throw e;
    }
  });

  app.put('/api/v1/rule-packs/:id', { preHandler: requireRole('admin'), schema: { body: packSchema } }, async (req, reply) => {
    const b = req.body;
    try {
      const { rows } = await q(
        `UPDATE rule_packs SET name = $2, description = COALESCE($3, description), updated_at = now()
         WHERE id = $1 RETURNING *`, [req.params.id, b.name, b.description ?? null]);
      if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
      if (Array.isArray(b.items)) await upsertItems(req.params.id, b.items);
      await syncPack(req.params.id);
      await audit(req, 'rulepack.update', 'rule_pack', req.params.id, b);
      return { pack: (await loadPacks('WHERE id = $1', [req.params.id]))[0] };
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ title: 'A pack with that name already exists', status: 409 });
      throw e;
    }
  });

  app.delete('/api/v1/rule-packs/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await resolveIncidentsFor(
      'pack_binding_id IN (SELECT id FROM rule_pack_bindings WHERE pack_id = $1)', [req.params.id],
      'auto-resolved: rule pack deleted');
    const { rowCount } = await q('DELETE FROM rule_packs WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'rulepack.delete', 'rule_pack', req.params.id);
    return { ok: true };
  });

  // Apply a pack. With scope_type "project" and per_group (default true) every
  // selected group gets its own binding, so thresholds can later be overridden
  // per group; per_group false makes one binding covering all of them.
  app.post('/api/v1/rule-packs/:id/apply', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['scope_type'],
        properties: { ...bindingProps, per_group: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    const { rows: pk } = await q('SELECT id FROM rule_packs WHERE id = $1', [req.params.id]);
    if (!pk[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    const b = req.body;
    const ids = b.scope_ids || [];
    if (b.scope_type !== 'all' && !ids.length) {
      return reply.code(400).send({ title: 'Pick at least one group or server', status: 400 });
    }
    const scopes = b.scope_type === 'project' && b.per_group !== false
      ? ids.map((g) => [g])
      : [b.scope_type === 'all' ? [] : ids];
    const created = [];
    for (const scopeIds of scopes) {
      const { rows } = await q(
        `INSERT INTO rule_pack_bindings (pack_id, scope_type, scope_ids, channels, overrides, enabled)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.params.id, b.scope_type, scopeIds, JSON.stringify(b.channels || []),
         JSON.stringify(b.overrides || {}), b.enabled ?? true]);
      await syncBinding(rows[0].id);
      created.push(rows[0].id);
    }
    await audit(req, 'rulepack.apply', 'rule_pack', req.params.id, { ...b, bindings: created });
    return reply.code(201).send({ bindings: created, pack: (await loadPacks('WHERE id = $1', [req.params.id]))[0] });
  });

  app.put('/api/v1/rule-pack-bindings/:id', {
    preHandler: requireRole('admin'),
    schema: { body: { type: 'object', properties: bindingProps } },
  }, async (req, reply) => {
    const b = req.body;
    const { rows } = await q(
      `UPDATE rule_pack_bindings SET
         scope_type = COALESCE($2, scope_type), scope_ids = COALESCE($3, scope_ids),
         channels = COALESCE($4, channels), overrides = COALESCE($5, overrides),
         enabled = COALESCE($6, enabled), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.scope_type ?? null, b.scope_ids ?? null,
       b.channels ? JSON.stringify(b.channels) : null, b.overrides ? JSON.stringify(b.overrides) : null,
       b.enabled ?? null]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await syncBinding(req.params.id);
    await audit(req, 'rulepack.binding.update', 'rule_pack_binding', req.params.id, b);
    return { binding: rows[0] };
  });

  app.delete('/api/v1/rule-pack-bindings/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await resolveIncidentsFor('pack_binding_id = $1', [req.params.id], 'auto-resolved: rule pack removed from this scope');
    const { rowCount } = await q('DELETE FROM rule_pack_bindings WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'rulepack.binding.delete', 'rule_pack_binding', req.params.id);
    return { ok: true };
  });
}
