# monit — self-hosted server monitoring

Implementation of `SYSTEM-REQUIREMENTS-AND-ARCHITECTURE.md` (SRS-ARCH-MONIT v1.0.0).
Push-based fleet monitoring: a bash agent on each Linux host ships a JSON sample
every 10 s to a central Node/Fastify service backed by TimescaleDB, which
evaluates alert rules and serves a Vue 3 dashboard.

```
agent (bash) ──HTTPS+Bearer──▶ ingestion API ──▶ TimescaleDB (hypertable + caggs)
                                     │                    │
                                     ▼                    ▼
                              alert engine ──▶ pg_boss ──▶ Telegram / Slack / Webhook
                                     │
                              query API ──▶ Vue 3 dashboard
```

---

## Quick start

```bash
cp .env.example .env          # set DB_PASSWORD, JWT_SECRET, ADMIN_PASSWORD
docker compose up -d --build
open http://localhost:8080    # sign in with ADMIN_EMAIL / ADMIN_PASSWORD
```

Migrations run automatically on boot; the first admin user is seeded from `.env`.

**Already have a PostgreSQL?** Skip the bundled database container:

```bash
# .env → DATABASE_URL=postgres://monit:secret@host.docker.internal:5432/monit
docker compose -f docker-compose.external-db.yml up -d --build
```

Superuser is not required. TimescaleDB is used when it can actually be enabled
and falls back to plain PostgreSQL otherwise — see
[docs/OPERATIONS.md](docs/OPERATIONS.md#using-an-existing-postgresql).

### Add a server

1. Dashboard → **Projects** → *Register a server*. `server_id` must match the
   agent's `MONIT_SERVER_ID`. Copy the API key — it is shown **once**.
2. On the target host:

```bash
sudo ./agent/install.sh https://monitor.example.com web-prod-01 sk_agent_xxxx loop
```

`loop` installs the systemd unit (continuous, 10 s). Pass `cron` instead for
one-shot-per-minute mode. Config lands in `/etc/monit/agent.conf` (0640,
root:monit).

### Development

```bash
# terminal 1 — API (expects Postgres on :5432)
cd server && npm install && npm run dev
# terminal 2 — dashboard with API proxy on :5173
cd dashboard && npm install && npm run dev
```

---

## Layout

| Path | Contents |
|---|---|
| `agent/` | `monit-agent.sh`, systemd unit, `install.sh`, config example |
| `server/src/routes/` | ingest, auth, servers, projects, metrics, alerts |
| `server/src/workers/` | alert engine (state machine), notifier, channel adapters |
| `server/src/lib/` | metric extraction, health computation, auth helpers |
| `server/migrations/` | SQL migrations (run in filename order) |
| `dashboard/src/views/` | Fleet, ServerDetail, Incidents, Rules, Projects, Settings |
| `docs/` | [API reference](docs/API.md) · [operations](docs/OPERATIONS.md) · [decisions](docs/DECISIONS.md) |

---

## What the agent collects

CPU (total + per-core, from two `/proc/stat` snapshots), RAM, disk per mount,
network counters per interface, load average, uptime, and — when the tooling is
present — GPU (`nvidia-smi`), Docker, PM2, local HTTP health checks, and MySQL /
PostgreSQL connection counts. Missing tools degrade to `present: false` or `[]`;
they never abort the run.

Failure handling: one `curl` with hard timeouts (`--max-time 5`,
`--connect-timeout 2`). On failure the sample is written to a disk buffer capped
at `MONIT_BUFFER_MAX` files (oldest dropped); on the next success up to 10
buffered samples are drained. Memory stays at one sample; there is no retry
storm and no unbounded growth.

---

## Alerting

A rule is `metric comparator threshold` held for `duration_min`, scoped to all
servers / a project / a server list. The engine ticks every 30 s and keeps a
per-(rule, server) state machine in `rule_state`:

- **Debounce** — the condition must hold for the full duration before firing.
- **Hysteresis** — optional `recover_threshold` keeps an incident firing until
  the value clears a second boundary (fire at >90, recover at <85).
- **Flapping guard** — more than `flap_limit` fires inside `flap_window_min`
  opens the incident as `flapping` instead of paging again.
- **Lifecycle** — `firing → acknowledged → resolved`, plus `silenced` (auto-expires).
- **Reminders** — a still-firing incident re-notifies at most hourly.

Notifications go through pg_boss with exponential backoff, 5 attempts, then a
`notification_dead_letter` row. Channels: **Telegram** (Bot API), **Slack**
(incoming webhook), **generic webhook**.

> Line Notify — named in the source spec — was shut down in 2025 and is
> replaced here by Telegram. See [docs/DECISIONS.md](docs/DECISIONS.md).

Seeded rules: High RAM, Low Disk, CPU Sustained, Server Offline, HTTP Unhealthy,
GPU VRAM Pressure, Service Down, DB Connections. All start with no channels
attached — wire them in **Settings → channels**, then edit each rule.

---

## Storage

`system_metrics` is a hypertable (1-day chunks) with jsonb columns.
Continuous aggregates `metrics_1m` and `metrics_1h` drive dashboard queries;
the query API picks raw / 1m / 1h automatically from the requested span.
Retention: raw 14 d, 1-minute 90 d, 1-hour 2 y; raw compressed after 7 d.

Network counters are stored raw and converted to rates at query time, with a
gap guard: a rate is emitted only when consecutive samples are within 5× the
nominal step and the counter did not go backwards — otherwise the line breaks
rather than showing a fabricated average across an outage or a reboot.

**Without TimescaleDB** the migration runner detects the missing extension and
falls back to a plain table plus equivalent `metrics_1m` / `metrics_1h` views —
no hypertables, compression, or retention jobs. Fine for a handful of servers
and for tests; use the real extension in production.

---

## Security

- Agents authenticate with a per-server bearer token; only the SHA-256 hash is
  stored. The payload's `server_id` must match the key's owner (else 403).
- Per-server ingest rate limit (default 12 requests / 10 s → 429). Raise
  `INGEST_RATE_MAX` temporarily when backfilling.
- Dashboard users authenticate with JWT (15 min access + 7 d refresh), roles
  `viewer` / `operator` / `admin` enforced server-side on every route.
- Payloads are schema-validated and capped at 256 KB.
- Admin mutations are written to `audit_log`.
- Run behind a TLS-terminating reverse proxy; the app itself speaks plain HTTP
  on `:8080`.

---

## Verified end-to-end

Exercised against a live stack during development: agent → ingest (202) → storage
→ query API → dashboard, plus rule evaluation → incident → pg_boss → webhook
delivery → notification log, and the ack/resolve/silence transitions. Auth
rejections (bad key 401, `server_id` mismatch 403, ingest flood 429) confirmed.
