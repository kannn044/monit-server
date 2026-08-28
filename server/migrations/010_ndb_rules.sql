-- Alert rules for MySQL NDB Cluster.
--
-- Added disabled-by-default is tempting, but a cluster you are monitoring is a
-- cluster you want alerts for; instead every rule reads a metric that is NULL
-- unless the agent actually saw an NDB cluster, and a NULL metric is skipped.
-- Hosts without NDB therefore never evaluate these at all.
INSERT INTO alert_rules (name, metric, comparator, threshold, duration_min, severity, channels)
SELECT * FROM (VALUES
  -- The headline question: is any configured data node not STARTED?
  ('NDB Node Down',        'ndb.nodes_unhealthy',  '>',  0,  1,  'critical', '[]'::jsonb),
  -- Every node in a node group being gone takes the whole cluster down. The
  -- agent omits this metric when it cannot attribute a dead node to a group,
  -- so the rule is skipped rather than wrongly reassuring.
  ('NDB Node Group Down',  'ndb.node_groups_down', '>',  0,  0,  'critical', '[]'::jsonb),
  -- NDB keeps data in memory; when DataMemory fills, writes start failing.
  ('NDB Data Memory',      'ndb.data_memory_pct',  '>',  85, 5,  'critical', '[]'::jsonb),
  ('NDB Index Memory',     'ndb.index_memory_pct', '>',  85, 5,  'warning',  '[]'::jsonb),
  -- Without an arbitrator a split brain cannot be resolved.
  ('NDB Arbitrator Lost',  'ndb.arbitrator_connected', '<', 1, 2, 'warning', '[]'::jsonb)
) AS v(name, metric, comparator, threshold, duration_min, severity, channels)
WHERE NOT EXISTS (SELECT 1 FROM alert_rules a WHERE a.name = v.name);
--;;
-- Hysteresis on the memory rules: NDB usage sits right at a threshold for long
-- stretches, and without this it would flap.
UPDATE alert_rules SET recover_threshold = 80
 WHERE metric IN ('ndb.data_memory_pct', 'ndb.index_memory_pct')
   AND recover_threshold IS NULL;
