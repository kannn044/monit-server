-- One-time install tokens.
--
-- These exist so nobody has to carry an agent key by hand. The dashboard mints
-- a token, the person pastes one line on the machine being monitored, and the
-- server hands the agent key back exactly once.
--
-- Two properties matter and both are enforced here rather than in code:
--
--   * the token itself is never stored — only its SHA-256, the same way the
--     agent keys are handled, so a database dump cannot be replayed;
--   * `key_wrapped` holds the agent key encrypted with a key DERIVED FROM THE
--     RAW TOKEN. The database therefore has the ciphertext but not the means to
--     open it; only the person holding the token can. Losing the token means
--     the key is unrecoverable, which is the same promise the dashboard already
--     makes when it shows a key once.

CREATE TABLE IF NOT EXISTS install_tokens (
  token_hash   text PRIMARY KEY,
  server_id    text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  key_wrapped  text NOT NULL,             -- base64: iv | authtag | ciphertext
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_from    inet
);

--;;
-- Redemption looks a token up by hash (the primary key), so the only index that
-- earns its keep is the one the cleanup sweep uses.
CREATE INDEX IF NOT EXISTS install_tokens_expires_idx ON install_tokens (expires_at);

--;;
CREATE INDEX IF NOT EXISTS install_tokens_server_idx ON install_tokens (server_id);
