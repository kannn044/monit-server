-- @timescale
CREATE EXTENSION IF NOT EXISTS timescaledb;
--;;
-- @optional
-- Only needed for gen_random_uuid() on PostgreSQL 12 and older; the function is
-- built in from PG13 on. Skipped without failing when the role may not create
-- extensions (common on a managed or shared PostgreSQL server).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
