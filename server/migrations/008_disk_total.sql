-- Whole-machine storage percentage.
--
-- The seeded "Low Disk" rule watched disk.avail_kb, which is the *tightest*
-- mount. /boot (≈1 GB) and /boot/efi (≈512 MB) sit near capacity on every Linux
-- host by design, so a "< 5 GiB free" rule fired on the whole fleet regardless
-- of how much room the real data disks had.
CREATE OR REPLACE FUNCTION disk_total_used_pct(d jsonb)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN sum((e->>'size_kb')::bigint) > 0
              THEN 100.0 * sum((e->>'used_kb')::bigint) / sum((e->>'size_kb')::bigint)
              END
  FROM jsonb_array_elements(COALESCE(d, '[]'::jsonb)) e
$$;
--;;
-- Repoint the rule at the whole machine. Only rows still matching the seeded
-- definition are touched, so a rule someone has edited is left alone.
UPDATE alert_rules
   SET metric = 'disk.total_used_pct', comparator = '>', threshold = 80,
       name = 'Disk Space', updated_at = now()
 WHERE metric = 'disk.avail_kb' AND name = 'Low Disk';
--;;
-- Close the incidents the old rule raised so hosts do not sit in a permanent
-- critical state for a threshold that no longer exists.
UPDATE incidents
   SET status = 'resolved', resolved_at = now(),
       notes = COALESCE(notes || ' | ', '')
               || 'auto-resolved: per-mount Low Disk rule replaced by whole-machine disk.total_used_pct'
 WHERE metric = 'disk.avail_kb'
   AND status IN ('firing', 'acknowledged', 'flapping', 'silenced');
--;;
DELETE FROM rule_state
 WHERE rule_id IN (SELECT id FROM alert_rules WHERE metric = 'disk.total_used_pct');
--;;
-- @vanilla
-- The new column is appended at the END: that is the only shape of change
-- CREATE OR REPLACE VIEW accepts, and it avoids dropping anything.
CREATE OR REPLACE VIEW metrics_1m AS
SELECT
  date_trunc('minute', time)                    AS bucket,
  server_id,
  count(*)                                      AS samples,
  avg((cpu->>'total')::double precision)        AS cpu_total_pct,
  max((cpu->>'total')::double precision)        AS cpu_max_pct,
  avg((ram->>'used_pct')::double precision)     AS ram_used_pct,
  min((ram->>'free_kb')::bigint)                AS ram_free_kb,
  min((ram->>'available_kb')::bigint)           AS ram_available_kb,
  avg((load->>'1m')::double precision)          AS load_1m,
  avg((load->>'5m')::double precision)          AS load_5m,
  avg((load->>'15m')::double precision)         AS load_15m,
  max((load->>'cores')::int)                    AS cores,
  max(uptime_s)                                 AS uptime_s,
  avg(disk_max_used_pct(disk))                  AS disk_used_pct,
  min(disk_min_avail_kb(disk))                  AS disk_avail_kb,
  avg(gpu_max_util_pct(gpu))                    AS gpu_util_pct,
  avg(gpu_max_mem_used_pct(gpu))                AS gpu_mem_used_pct,
  max(net_counter_sum(network, 'rx_bytes'))     AS net_rx_bytes,
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes,
  avg(disk_total_used_pct(disk))                AS disk_total_used_pct
FROM system_metrics
GROUP BY 1, 2;
--;;
-- @vanilla
CREATE OR REPLACE VIEW metrics_1h AS
SELECT
  date_trunc('hour', time)                      AS bucket,
  server_id,
  count(*)                                      AS samples,
  avg((cpu->>'total')::double precision)        AS cpu_total_pct,
  max((cpu->>'total')::double precision)        AS cpu_max_pct,
  avg((ram->>'used_pct')::double precision)     AS ram_used_pct,
  min((ram->>'free_kb')::bigint)                AS ram_free_kb,
  min((ram->>'available_kb')::bigint)           AS ram_available_kb,
  avg((load->>'1m')::double precision)          AS load_1m,
  avg((load->>'5m')::double precision)          AS load_5m,
  avg((load->>'15m')::double precision)         AS load_15m,
  max((load->>'cores')::int)                    AS cores,
  max(uptime_s)                                 AS uptime_s,
  avg(disk_max_used_pct(disk))                  AS disk_used_pct,
  min(disk_min_avail_kb(disk))                  AS disk_avail_kb,
  avg(gpu_max_util_pct(gpu))                    AS gpu_util_pct,
  avg(gpu_max_mem_used_pct(gpu))                AS gpu_mem_used_pct,
  max(net_counter_sum(network, 'rx_bytes'))     AS net_rx_bytes,
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes,
  avg(disk_total_used_pct(disk))                AS disk_total_used_pct
FROM system_metrics
GROUP BY 1, 2;
--;;
-- @timescale
-- A continuous aggregate cannot gain a column in place, so the two rollups are
-- rebuilt. Timescale re-materialises them from the raw hypertable in the
-- background; long-range charts fill back in within a few minutes.
DROP MATERIALIZED VIEW IF EXISTS metrics_1m CASCADE;
--;;
-- @timescale
CREATE MATERIALIZED VIEW metrics_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time)                 AS bucket,
  server_id,
  count(*)                                      AS samples,
  avg((cpu->>'total')::double precision)        AS cpu_total_pct,
  max((cpu->>'total')::double precision)        AS cpu_max_pct,
  avg((ram->>'used_pct')::double precision)     AS ram_used_pct,
  min((ram->>'free_kb')::bigint)                AS ram_free_kb,
  min((ram->>'available_kb')::bigint)           AS ram_available_kb,
  avg((load->>'1m')::double precision)          AS load_1m,
  avg((load->>'5m')::double precision)          AS load_5m,
  avg((load->>'15m')::double precision)         AS load_15m,
  max((load->>'cores')::int)                    AS cores,
  max(uptime_s)                                 AS uptime_s,
  avg(disk_max_used_pct(disk))                  AS disk_used_pct,
  min(disk_min_avail_kb(disk))                  AS disk_avail_kb,
  avg(gpu_max_util_pct(gpu))                    AS gpu_util_pct,
  avg(gpu_max_mem_used_pct(gpu))                AS gpu_mem_used_pct,
  max(net_counter_sum(network, 'rx_bytes'))     AS net_rx_bytes,
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes,
  avg(disk_total_used_pct(disk))                AS disk_total_used_pct
FROM system_metrics
GROUP BY bucket, server_id
WITH NO DATA;
--;;
-- @timescale
SELECT add_continuous_aggregate_policy('metrics_1m',
  start_offset => INTERVAL '15 minutes', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
--;;
-- @timescale
SELECT add_retention_policy('metrics_1m', INTERVAL '90 days');
--;;
-- @timescale
DROP MATERIALIZED VIEW IF EXISTS metrics_1h CASCADE;
--;;
-- @timescale
CREATE MATERIALIZED VIEW metrics_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time)                   AS bucket,
  server_id,
  count(*)                                      AS samples,
  avg((cpu->>'total')::double precision)        AS cpu_total_pct,
  max((cpu->>'total')::double precision)        AS cpu_max_pct,
  avg((ram->>'used_pct')::double precision)     AS ram_used_pct,
  min((ram->>'free_kb')::bigint)                AS ram_free_kb,
  min((ram->>'available_kb')::bigint)           AS ram_available_kb,
  avg((load->>'1m')::double precision)          AS load_1m,
  avg((load->>'5m')::double precision)          AS load_5m,
  avg((load->>'15m')::double precision)         AS load_15m,
  max((load->>'cores')::int)                    AS cores,
  max(uptime_s)                                 AS uptime_s,
  avg(disk_max_used_pct(disk))                  AS disk_used_pct,
  min(disk_min_avail_kb(disk))                  AS disk_avail_kb,
  avg(gpu_max_util_pct(gpu))                    AS gpu_util_pct,
  avg(gpu_max_mem_used_pct(gpu))                AS gpu_mem_used_pct,
  max(net_counter_sum(network, 'rx_bytes'))     AS net_rx_bytes,
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes,
  avg(disk_total_used_pct(disk))                AS disk_total_used_pct
FROM system_metrics
GROUP BY bucket, server_id
WITH NO DATA;
--;;
-- @timescale
SELECT add_continuous_aggregate_policy('metrics_1h',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
--;;
-- @timescale
SELECT add_retention_policy('metrics_1h', INTERVAL '2 years');
