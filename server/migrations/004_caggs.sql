-- @timescale
-- 1-minute rollups (drives most dashboard queries)
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
  -- cumulative counters: keep bucket max; rate = diff between buckets at query time
  max(net_counter_sum(network, 'rx_bytes'))     AS net_rx_bytes,
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes
FROM system_metrics
GROUP BY bucket, server_id
WITH NO DATA;
--;;
-- @timescale
SELECT add_continuous_aggregate_policy('metrics_1m',
  start_offset      => INTERVAL '15 minutes',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
--;;
-- @timescale
-- 1-hour rollups for long-range views
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
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes
FROM system_metrics
GROUP BY bucket, server_id
WITH NO DATA;
--;;
-- @timescale
SELECT add_continuous_aggregate_policy('metrics_1h',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
--;;
-- @vanilla
-- Plain-PostgreSQL fallback: same shape as the continuous aggregate, computed on the fly.
CREATE VIEW metrics_1m AS
SELECT
  date_trunc('minute', time)                   AS bucket,
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
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes
FROM system_metrics
GROUP BY 1, 2
--;;
-- @vanilla
-- Plain-PostgreSQL fallback: same shape as the continuous aggregate, computed on the fly.
CREATE VIEW metrics_1h AS
SELECT
  date_trunc('hour', time)                   AS bucket,
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
  max(net_counter_sum(network, 'tx_bytes'))     AS net_tx_bytes
FROM system_metrics
GROUP BY 1, 2
