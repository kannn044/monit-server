-- Internal key/value store. Currently holds the auto-generated JWT signing
-- secret so a fresh install needs no configuration at all, while tokens still
-- survive restarts (a secret regenerated on every boot would sign everyone out).
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
