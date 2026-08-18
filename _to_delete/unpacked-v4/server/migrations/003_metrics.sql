CREATE TABLE system_metrics (
  time       timestamptz NOT NULL DEFAULT now(),
  server_id  text        NOT NULL,
  cpu        jsonb,
  ram        jsonb,
  load       jsonb,
  uptime_s   double precision,
  disk       jsonb,
  network    jsonb,      -- cumulative counters; rates derived at query time
  gpu        jsonb,
  docker     jsonb,
  pm2        jsonb,
  http       jsonb,
  databases  jsonb
);
--;;
-- @timescale
SELECT create_hypertable('system_metrics', 'time', chunk_time_interval => INTERVAL '1 day');
--;;
CREATE INDEX system_metrics_server_time_idx ON system_metrics (server_id, time DESC);
--;;
-- Immutable helpers so jsonb arrays can be used inside continuous aggregates
CREATE OR REPLACE FUNCTION net_counter_sum(net jsonb, field text)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((e->>field)::bigint), 0)
  FROM jsonb_array_elements(COALESCE(net, '[]'::jsonb)) e
$$;
--;;
CREATE OR REPLACE FUNCTION disk_max_used_pct(d jsonb)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT max((e->>'used_pct')::double precision)
  FROM jsonb_array_elements(COALESCE(d, '[]'::jsonb)) e
$$;
--;;
CREATE OR REPLACE FUNCTION disk_min_avail_kb(d jsonb)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT min((e->>'avail_kb')::bigint)
  FROM jsonb_array_elements(COALESCE(d, '[]'::jsonb)) e
$$;
--;;
CREATE OR REPLACE FUNCTION gpu_max_util_pct(g jsonb)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT max((e->>'util_pct')::double precision)
  FROM jsonb_array_elements(COALESCE(g, '[]'::jsonb)) e
$$;
--;;
CREATE OR REPLACE FUNCTION gpu_max_mem_used_pct(g jsonb)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT max(CASE WHEN (e->>'mem_total_mb')::double precision > 0
              THEN 100.0 * (e->>'mem_used_mb')::double precision / (e->>'mem_total_mb')::double precision
              ELSE NULL END)
  FROM jsonb_array_elements(COALESCE(g, '[]'::jsonb)) e
$$;
