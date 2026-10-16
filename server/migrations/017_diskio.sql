-- Disk read/write throughput.
--
-- The agent now reports `diskio`: cumulative counters per physical disk from
-- /proc/diskstats (read_bytes, write_bytes, reads, writes, io_ms). Like the
-- network counters these are monotonic; rates are derived at query time and by
-- the alert engine from consecutive samples.
--
-- Rollups go into their OWN continuous aggregates (metrics_io_1m/1h) instead of
-- adding columns to metrics_1m/1h. Adding a column to a Timescale continuous
-- aggregate means dropping and rebuilding it, and the rebuild can only
-- re-materialise from raw samples still inside the 14-day raw retention — the
-- 1m (90 d) and 1h (2 y) history older than that would be lost.
ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS diskio jsonb;
--;;
CREATE OR REPLACE FUNCTION diskio_counter_sum(d jsonb, field text)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((e->>field)::bigint), 0)
  FROM jsonb_array_elements(COALESCE(d, '[]'::jsonb)) e
$$;
--;;
-- @timescale
CREATE MATERIALIZED VIEW metrics_io_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time)                       AS bucket,
  server_id,
  max(diskio_counter_sum(diskio, 'read_bytes'))       AS disk_read_bytes,
  max(diskio_counter_sum(diskio, 'write_bytes'))      AS disk_write_bytes,
  max(diskio_counter_sum(diskio, 'reads'))            AS disk_reads,
  max(diskio_counter_sum(diskio, 'writes'))           AS disk_writes,
  max(net_counter_sum(network, 'rx_errs') + net_counter_sum(network, 'tx_errs')) AS net_errs,
  max(net_counter_sum(network, 'rx_drop') + net_counter_sum(network, 'tx_drop')) AS net_drops
FROM system_metrics
GROUP BY bucket, server_id
WITH NO DATA;
--;;
-- @timescale
SELECT add_continuous_aggregate_policy('metrics_io_1m',
  start_offset => INTERVAL '15 minutes', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
--;;
-- @timescale
SELECT add_retention_policy('metrics_io_1m', INTERVAL '90 days');
--;;
-- @timescale
CREATE MATERIALIZED VIEW metrics_io_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time)                         AS bucket,
  server_id,
  max(diskio_counter_sum(diskio, 'read_bytes'))       AS disk_read_bytes,
  max(diskio_counter_sum(diskio, 'write_bytes'))      AS disk_write_bytes,
  max(diskio_counter_sum(diskio, 'reads'))            AS disk_reads,
  max(diskio_counter_sum(diskio, 'writes'))           AS disk_writes,
  max(net_counter_sum(network, 'rx_errs') + net_counter_sum(network, 'tx_errs')) AS net_errs,
  max(net_counter_sum(network, 'rx_drop') + net_counter_sum(network, 'tx_drop')) AS net_drops
FROM system_metrics
GROUP BY bucket, server_id
WITH NO DATA;
--;;
-- @timescale
SELECT add_continuous_aggregate_policy('metrics_io_1h',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
--;;
-- @timescale
SELECT add_retention_policy('metrics_io_1h', INTERVAL '2 years');
--;;
-- @vanilla
CREATE OR REPLACE VIEW metrics_io_1m AS
SELECT
  date_trunc('minute', time)                          AS bucket,
  server_id,
  max(diskio_counter_sum(diskio, 'read_bytes'))       AS disk_read_bytes,
  max(diskio_counter_sum(diskio, 'write_bytes'))      AS disk_write_bytes,
  max(diskio_counter_sum(diskio, 'reads'))            AS disk_reads,
  max(diskio_counter_sum(diskio, 'writes'))           AS disk_writes,
  max(net_counter_sum(network, 'rx_errs') + net_counter_sum(network, 'tx_errs')) AS net_errs,
  max(net_counter_sum(network, 'rx_drop') + net_counter_sum(network, 'tx_drop')) AS net_drops
FROM system_metrics
GROUP BY 1, 2;
--;;
-- @vanilla
CREATE OR REPLACE VIEW metrics_io_1h AS
SELECT
  date_trunc('hour', time)                            AS bucket,
  server_id,
  max(diskio_counter_sum(diskio, 'read_bytes'))       AS disk_read_bytes,
  max(diskio_counter_sum(diskio, 'write_bytes'))      AS disk_write_bytes,
  max(diskio_counter_sum(diskio, 'reads'))            AS disk_reads,
  max(diskio_counter_sum(diskio, 'writes'))           AS disk_writes,
  max(net_counter_sum(network, 'rx_errs') + net_counter_sum(network, 'tx_errs')) AS net_errs,
  max(net_counter_sum(network, 'rx_drop') + net_counter_sum(network, 'tx_drop')) AS net_drops
FROM system_metrics
GROUP BY 1, 2;
