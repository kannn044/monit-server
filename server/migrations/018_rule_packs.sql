-- Rule packs: a named set of rule definitions applied to a group of servers in
-- one step.
--
--   rule_packs          the set ("Linux baseline", "DB hosts", ...)
--   rule_pack_items     one rule definition inside a pack (metric, threshold, ...)
--   rule_pack_bindings  "this pack applies to these groups / these servers / all",
--                       with its own channels and optional per-item overrides
--
-- Applying a pack MATERIALISES ordinary alert_rules rows, one per (binding,
-- item). The alert engine, incidents, rule_state and notifications therefore
-- work exactly as they do for hand-made rules; the rows are just owned by the
-- binding (edited through the pack, removed with it).
CREATE TABLE rule_packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE rule_pack_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id           uuid NOT NULL REFERENCES rule_packs(id) ON DELETE CASCADE,
  name              text NOT NULL,
  metric            text NOT NULL,
  comparator        text NOT NULL CHECK (comparator IN ('>','>=','<','<=','==','!=')),
  threshold         double precision,
  duration_min      double precision NOT NULL DEFAULT 0,
  recover_threshold double precision,
  severity          text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
  flap_limit        int NOT NULL DEFAULT 5,
  flap_window_min   int NOT NULL DEFAULT 30,
  sort              int NOT NULL DEFAULT 0
);
--;;
CREATE INDEX rule_pack_items_pack_idx ON rule_pack_items (pack_id, sort);
--;;
CREATE TABLE rule_pack_bindings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id    uuid NOT NULL REFERENCES rule_packs(id) ON DELETE CASCADE,
  scope_type text NOT NULL DEFAULT 'project' CHECK (scope_type IN ('project','servers','all')),
  scope_ids  text[] NOT NULL DEFAULT '{}',
  channels   jsonb NOT NULL DEFAULT '[]',
  -- { "<item id>": { "threshold": 85, "recover_threshold": 80, "duration_min": 5,
  --                  "severity": "critical", "enabled": false } }  — all keys optional
  overrides  jsonb NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--;;
ALTER TABLE alert_rules
  ADD COLUMN pack_binding_id uuid REFERENCES rule_pack_bindings(id) ON DELETE CASCADE,
  ADD COLUMN pack_item_id    uuid REFERENCES rule_pack_items(id)    ON DELETE CASCADE;
--;;
CREATE UNIQUE INDEX alert_rules_pack_uidx ON alert_rules (pack_binding_id, pack_item_id)
  WHERE pack_binding_id IS NOT NULL;
--;;
-- A starter pack. Thresholds are copied from the global rules seeded in
-- 006_seed_rules.sql, plus disk busy %. Network and disk THROUGHPUT items are
-- deliberately not seeded: a sensible MB/s ceiling depends on the NIC and the
-- storage behind each group, so add them per pack.
INSERT INTO rule_packs (name, description)
SELECT 'Linux baseline', 'CPU / RAM / disk space / disk busy / offline'
WHERE NOT EXISTS (SELECT 1 FROM rule_packs WHERE name = 'Linux baseline');
--;;
INSERT INTO rule_pack_items (pack_id, name, metric, comparator, threshold, duration_min, recover_threshold, severity, sort)
SELECT p.id, v.name, v.metric, v.comparator, v.threshold, v.duration_min, v.recover_threshold, v.severity, v.sort
FROM rule_packs p
CROSS JOIN (VALUES
  ('Server Offline', 'no_sample',           '>', 30::double precision,  0::double precision, NULL::double precision, 'critical', 1),
  ('High RAM',       'ram.used_pct',        '>', 90,                    3,                   NULL,                   'critical', 2),
  ('CPU Sustained',  'cpu.total',           '>', 95,                    10,                  NULL,                   'warning',  3),
  ('Disk Space',     'disk.total_used_pct', '>', 80,                    5,                   NULL,                   'critical', 4),
  ('Disk Busy',      'disk.busy_pct',       '>', 90,                    10,                  80,                     'warning',  5)
) AS v(name, metric, comparator, threshold, duration_min, recover_threshold, severity, sort)
WHERE p.name = 'Linux baseline'
  AND NOT EXISTS (SELECT 1 FROM rule_pack_items i WHERE i.pack_id = p.id);
