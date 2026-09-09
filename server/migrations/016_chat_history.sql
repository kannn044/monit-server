-- One saved conversation per user, kept until they clear it.
--
-- Stored server-side rather than in the browser on purpose: the same person
-- signs in from the office machine and from a laptop, and a conversation that
-- only exists in one browser's localStorage is gone the moment they move. The
-- row is replaced wholesale on every save, so there is exactly one current
-- conversation per user and "Clear" is a DELETE.
CREATE TABLE ai_chat_history (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  messages   jsonb       NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
--;;
-- How long a report actually took.
--
-- Without this the progress screen can only count upwards, which tells the user
-- nothing about whether to wait or come back later. Recording the finish time
-- lets the next report of the same kind be given a real estimate drawn from
-- this installation's own hardware rather than a number someone guessed.
ALTER TABLE ai_reports ADD COLUMN IF NOT EXISTS finished_at timestamptz;
--;;
UPDATE ai_reports SET finished_at = created_at WHERE finished_at IS NULL AND status = 'ready';
