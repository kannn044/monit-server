-- Generated AI reports.
--
-- The rendered HTML is stored alongside the dataset and the narrative rather
-- than regenerated on view. Two reasons: a report is a record of what the fleet
-- looked like at a moment, so re-rendering it later from live data would
-- silently change history; and regeneration would mean another model call for
-- every reader of every report.
CREATE TABLE ai_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text        NOT NULL,
  title      text        NOT NULL DEFAULT '',
  params     jsonb       NOT NULL DEFAULT '{}',
  dataset    jsonb       NOT NULL DEFAULT '{}',   -- the figures, computed in SQL
  narrative  jsonb       NOT NULL DEFAULT '{}',   -- the model's interpretation of them
  html       text        NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE INDEX ai_reports_created_idx ON ai_reports (created_at DESC);
--;;
-- Chat telemetry: what was asked, which tools ran, how long it took.
--
-- Without this there is no way to tell whether a prompt change helped — the
-- alternative is judging model quality by how the last three answers felt.
CREATE TABLE ai_chat_log (
  id          bigserial PRIMARY KEY,
  user_email  text,
  question    text        NOT NULL,
  intent      text,
  tools       jsonb       NOT NULL DEFAULT '[]',
  answer_chars int,
  latency_ms  int,
  error       text,
  feedback    smallint,                            -- +1 / -1, set later from the UI
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE INDEX ai_chat_log_created_idx ON ai_chat_log (created_at DESC);
