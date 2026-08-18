-- Users (dashboard identities, JWT + RBAC)
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','operator','admin')),
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  environment text NOT NULL DEFAULT 'Dev',          -- 'Prod' | 'UAT' | 'Dev' | custom label
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE servers (
  id          text PRIMARY KEY,                     -- == server_id reported by the agent
  name        text NOT NULL,
  ip          inet,
  os          text,
  last_seen   timestamptz,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE server_projects (
  server_id  text NOT NULL REFERENCES servers(id)  ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, project_id)
);
--;;
CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT 'agent',
  key_hash    text NOT NULL,                        -- sha256 hex of the bearer token
  scope       text NOT NULL DEFAULT 'ingest',
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE INDEX api_keys_hash_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;
--;;
CREATE TABLE notify_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,                  -- referenced by alert_rules.channels
  type       text NOT NULL CHECK (type IN ('telegram','slack','webhook')),
  config     jsonb NOT NULL DEFAULT '{}',           -- telegram:{bot_token,chat_id} slack:{webhook_url} webhook:{url,headers}
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE alert_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  scope_type      text NOT NULL DEFAULT 'all' CHECK (scope_type IN ('project','servers','all')),
  scope_ids       text[] NOT NULL DEFAULT '{}',     -- project uuids or server ids depending on scope_type
  metric          text NOT NULL,                    -- e.g. ram.used_pct, cpu.total, disk.avail_kb, http.status_code, no_sample
  comparator      text NOT NULL CHECK (comparator IN ('>','>=','<','<=','==','!=')),
  threshold       double precision,
  duration_min    double precision NOT NULL DEFAULT 0,
  recover_threshold double precision,               -- optional hysteresis boundary
  severity        text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
  channels        jsonb NOT NULL DEFAULT '[]',      -- ["slack-ops","telegram-oncall"] (notify_channels.name)
  enabled         boolean NOT NULL DEFAULT true,
  flap_limit      int NOT NULL DEFAULT 5,
  flap_window_min int NOT NULL DEFAULT 30,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
--;;
-- Expected workloads per server (drives service_down alerts)
CREATE TABLE expected_services (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('docker','pm2')),
  name       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  UNIQUE (server_id, kind, name)
);
--;;
CREATE TABLE incidents (
  id              text PRIMARY KEY,                 -- inc_YYYYMMDD_xxxxxx
  rule_id         uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name       text NOT NULL DEFAULT '',
  server_id       text REFERENCES servers(id) ON DELETE CASCADE,
  severity        text NOT NULL,
  status          text NOT NULL DEFAULT 'firing' CHECK (status IN ('firing','acknowledged','resolved','flapping','silenced')),
  metric          text,
  value           double precision,
  threshold       double precision,
  message         text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  silenced_until  timestamptz,
  notes           text,
  notified        jsonb NOT NULL DEFAULT '[]'
);
--;;
CREATE INDEX incidents_server_idx ON incidents (server_id, started_at DESC);
--;;
CREATE INDEX incidents_status_idx ON incidents (status, started_at DESC);
--;;
-- Per (rule, server) evaluation state for the duration state machine
CREATE TABLE rule_state (
  rule_id    uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  server_id  text NOT NULL,
  since      timestamptz,                           -- condition first observed true (NULL = currently false)
  firing_incident_id text,
  last_value double precision,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, server_id)
);
--;;
CREATE TABLE notification_log (
  id          bigserial PRIMARY KEY,
  incident_id text REFERENCES incidents(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  event       text NOT NULL DEFAULT 'alert.fired',
  success     boolean NOT NULL,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE notification_dead_letter (
  id          bigserial PRIMARY KEY,
  incident_id text,
  channel     text NOT NULL,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  user_email text,
  action     text NOT NULL,                          -- e.g. rule.create, server.delete, key.rotate
  entity     text,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
