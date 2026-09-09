-- Reports become asynchronous.
--
-- Generating one runs a model call that legitimately takes a minute or more on
-- a local GPU. As a plain request that meant the browser held an open POST for
-- the whole time — no progress, a disabled button, and past nginx's
-- proxy_read_timeout a 504 that discarded a report the server had in fact
-- finished writing. The row is now created first and filled in afterwards, so
-- the page has something to poll and a slow model cannot lose its own work.
ALTER TABLE ai_reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
--;;
ALTER TABLE ai_reports ADD COLUMN IF NOT EXISTS error text;
--;;
-- Existing rows were written by the synchronous path and are complete.
UPDATE ai_reports SET status = 'ready' WHERE status IS NULL OR status = '';
--;;
CREATE INDEX IF NOT EXISTS ai_reports_status_idx ON ai_reports (status, created_at DESC);
