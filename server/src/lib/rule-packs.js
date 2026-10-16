// Rule packs → concrete alert_rules rows.
//
// A binding ("pack P applies to groups G1,G2 with channels C") owns one
// alert_rules row per pack item. Those rows are what the alert engine
// evaluates, so packs need no changes to the engine, incidents or notifier.
// Every change to a pack, an item or a binding re-runs syncBinding(), which
// upserts on (pack_binding_id, pack_item_id): rule ids — and with them
// rule_state and open incidents — survive an edit. Removed items/bindings take
// their rules with them via ON DELETE CASCADE.
import { q } from '../db/pool.js';

const OVERRIDABLE = ['threshold', 'recover_threshold', 'duration_min', 'severity'];

async function scopeLabel(b) {
  if (b.scope_type === 'all') return 'all servers';
  if (b.scope_type === 'servers') {
    return (b.scope_ids || []).length === 1 ? b.scope_ids[0] : `${(b.scope_ids || []).length} servers`;
  }
  const ids = (b.scope_ids || []).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!ids.length) return 'no group';
  const { rows } = await q('SELECT name FROM projects WHERE id = ANY($1::uuid[]) ORDER BY name', [ids]);
  return rows.map((r) => r.name).join(', ') || 'no group';
}

/** Effective value for one item under one binding's overrides. */
function effective(item, override = {}) {
  const out = {};
  for (const k of OVERRIDABLE) {
    const v = override[k];
    out[k] = v !== undefined && v !== null && v !== '' ? v : item[k];
  }
  return out;
}

export async function syncBinding(bindingId) {
  const { rows: [b] } = await q(
    `SELECT b.*, p.name AS pack_name FROM rule_pack_bindings b
     JOIN rule_packs p ON p.id = b.pack_id WHERE b.id = $1`, [bindingId]);
  if (!b) return 0;
  const { rows: items } = await q(
    'SELECT * FROM rule_pack_items WHERE pack_id = $1 ORDER BY sort, name', [b.pack_id]);
  const label = await scopeLabel(b);
  const overrides = b.overrides || {};
  for (const it of items) {
    const o = overrides[it.id] || {};
    const e = effective(it, o);
    await q(
      `INSERT INTO alert_rules (name, scope_type, scope_ids, metric, comparator, threshold, duration_min,
         recover_threshold, severity, channels, enabled, flap_limit, flap_window_min,
         pack_binding_id, pack_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (pack_binding_id, pack_item_id) WHERE pack_binding_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, scope_type = EXCLUDED.scope_type, scope_ids = EXCLUDED.scope_ids,
         metric = EXCLUDED.metric, comparator = EXCLUDED.comparator, threshold = EXCLUDED.threshold,
         duration_min = EXCLUDED.duration_min, recover_threshold = EXCLUDED.recover_threshold,
         severity = EXCLUDED.severity, channels = EXCLUDED.channels, enabled = EXCLUDED.enabled,
         flap_limit = EXCLUDED.flap_limit, flap_window_min = EXCLUDED.flap_window_min, updated_at = now()`,
      [`${it.name} · ${b.pack_name} [${label}]`, b.scope_type, b.scope_ids || [], it.metric, it.comparator,
       e.threshold, e.duration_min, e.recover_threshold, e.severity, JSON.stringify(b.channels || []),
       b.enabled && o.enabled !== false, it.flap_limit, it.flap_window_min, b.id, it.id]);
  }
  return items.length;
}

export async function syncPack(packId) {
  const { rows } = await q('SELECT id FROM rule_pack_bindings WHERE pack_id = $1', [packId]);
  for (const r of rows) await syncBinding(r.id);
}

/** Re-sync everything (startup): picks up renamed groups in rule names. */
export async function syncAllBindings(log = console) {
  const { rows } = await q('SELECT id FROM rule_pack_bindings');
  for (const r of rows) {
    try { await syncBinding(r.id); } catch (e) { log.warn?.(`[packs] sync ${r.id} failed: ${e.message}`); }
  }
}

/**
 * Close incidents that belong to rules about to disappear. Without this they
 * stay "firing" forever: the rule (and its rule_state) is gone, so nothing
 * would ever evaluate them back to resolved.
 */
export async function resolveIncidentsFor(where, params, note) {
  await q(
    `UPDATE incidents SET status = 'resolved', resolved_at = now(),
       notes = COALESCE(notes || ' | ', '') || $${params.length + 1}
     WHERE status IN ('firing','acknowledged','flapping','silenced')
       AND rule_id IN (SELECT id FROM alert_rules WHERE ${where})`,
    [...params, note]);
}
