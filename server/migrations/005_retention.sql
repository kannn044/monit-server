-- @timescale
-- Raw samples: 14 days
SELECT add_retention_policy('system_metrics', INTERVAL '14 days');
--;;
-- @timescale
-- 1-minute rollups: 90 days
SELECT add_retention_policy('metrics_1m', INTERVAL '90 days');
--;;
-- @timescale
-- 1-hour rollups: 2 years
SELECT add_retention_policy('metrics_1h', INTERVAL '2 years');
--;;
-- @timescale
-- Compress raw data after 7 days
ALTER TABLE system_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'server_id',
  timescaledb.compress_orderby = 'time DESC'
);
--;;
-- @timescale
SELECT add_compression_policy('system_metrics', INTERVAL '7 days');
