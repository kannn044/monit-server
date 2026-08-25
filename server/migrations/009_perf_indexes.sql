-- Fleet-wide time-range scans.
--
-- The only index on system_metrics was (server_id, time DESC), which cannot
-- serve a query that filters on time across ALL servers — the Fleet page's
-- 24 h rollup and prune-metrics.sh's retention DELETE both fell back to a full
-- sequential scan (1.6 s over 1.7 M rows, and growing).
--
-- BRIN rather than btree: samples are appended in time order, so each block
-- range holds a narrow time span and pruning is excellent — 144 kB of index for
-- a 1.5 GB table, versus roughly 36 MB for the btree equivalent.
-- @vanilla
CREATE INDEX IF NOT EXISTS system_metrics_time_brin
  ON system_metrics USING brin (time) WITH (pages_per_range = 64);
