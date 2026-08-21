# Operations guide

## Deploying the central tier

```bash
cp .env.example .env      # DB_PASSWORD, JWT_SECRET (long random), ADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f app
```

Migrations run at boot and are idempotent (tracked in `schema_migrations`).
The admin user is seeded only when `users` is empty — change the password after
first sign-in.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres/TimescaleDB connection string |
| `JWT_SECRET` | — | **required in production**; rotating it invalidates sessions |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | first-run admin seed |
| `PORT` | 8080 | HTTP listen port |
| `SAMPLE_INTERVAL_S` | 10 | expected agent cadence; offline = 3× this |
| `ALERT_TICK_S` | 30 | alert engine evaluation interval |
| `INGEST_RATE_MAX` | 12 | max ingest requests per server per window |
| `INGEST_RATE_WINDOW_MS` | 10000 | rate-limit window |
| `LOG_LEVEL` | info | pino level |

### TLS

The app speaks plain HTTP. Terminate TLS in front of it — agents must not send
bearer tokens over cleartext.

```caddy
monitor.example.com {
    reverse_proxy localhost:8080
}
```

---

## Rolling out agents

```bash
sudo ./agent/install.sh https://monitor.example.com <server_id> <api_key> loop
```

The installer creates the `monit` system user, installs to `/opt/monit`, writes
`/etc/monit/agent.conf` (0640 root:monit), and enables the systemd unit.

Verify:

```bash
systemctl status monit-agent
journalctl -u monit-agent -f
bash /opt/monit/monit-agent.sh --print | head -40    # payload without sending
```

The unit runs as non-root with `NoNewPrivileges`, `ProtectSystem=full`,
`MemoryMax=32M`, `CPUQuota=20%`.

### Optional collectors

| Feature | Requirement |
|---|---|
| Docker | `monit` user in the `docker` group |
| PM2 | agent runs as the PM2 owner; `jq` for per-process detail |
| GPU | `nvidia-smi` on PATH |
| HTTP checks | set `MONIT_HTTP_CHECKS` (comma-separated URLs) |
| MySQL | `MONIT_MYSQL=1` + a read-only login in `~/.my.cnf` |
| PostgreSQL | `MONIT_PG=1` + `PG*` env or `.pgpass` for a read-only role |

Create least-privilege DB users:

```sql
-- MySQL
CREATE USER 'monit'@'localhost' IDENTIFIED BY '...';
GRANT PROCESS ON *.* TO 'monit'@'localhost';

-- PostgreSQL
CREATE ROLE monit LOGIN PASSWORD '...';
GRANT pg_monitor TO monit;
```

### Multiple interfaces

`MONIT_NET_IFACES="eth0 eth1"` (space-separated). Per-interface series appear on
short ranges; long-range rollups sum interfaces, so a changing interface set can
distort one aggregate bucket.

---

## Day-2

### Lost or rotated keys

**A key can never be displayed twice.** Only its SHA-256 hash is stored, so the
dashboard has no "show me the key" button and no support path can recover one.
The card shown at registration is the single chance to copy it — it carries a
**Copy key** button and the exact `monit-config.sh` command that installs it.

Forgot a key? Issue a replacement: **Projects → server row → New key** (or
server detail → **New key**, or `POST /servers/:id/keys/rotate`). The old key is
revoked immediately — apply the new one on the host with

```bash
ssh -t user@host 'sudo /opt/monit/monit-config.sh -k sk_agent_new…'
```

Samples buffer on disk meanwhile (up to `MONIT_BUFFER_MAX`) but are rejected
while the agent still holds the stale key; they drop once the buffer cap is hit.

### Deleting a server, and reusing its ID

**Delete** offers two outcomes, because they are not the same thing:

| Choice | What happens | ID afterwards |
|---|---|---|
| Remove from the dashboard | keys revoked, open alerts closed, hidden everywhere; metric history kept | held — reusable, see below |
| Erase permanently | registration, keys, alert history and **every stored sample** deleted | free |

Removed servers are listed under **Deleted servers** on the Projects page with
**Restore** and **Erase permanently**. Restoring issues a new key, since the old
one was revoked on delete.

Registering an ID that belongs to a removed server restores it rather than
failing — that is what "Server ID already exists" used to mean when a deleted
server was invisible but still held its primary key. Only an ID that is
*currently live* is a genuine conflict, and the 409 now says so and points at
**New key**.

```bash
# erase from the API instead of the UI
curl -X DELETE 'https://monitor.example.com/api/v1/servers/web-prod-01?purge=1' \
  -H "Authorization: Bearer $ADMIN_JWT"
```

### Tuning alerts

Start with the seeded rules, attach channels, then tighten. Two knobs prevent
most alert fatigue: raise `duration_min` for spiky metrics (CPU), and set
`recover_threshold` a few points below the trigger for metrics that hover at the
boundary (RAM, disk).

`Server Offline` uses `no_sample` with `duration_min: 0` — the seconds-since-last-sample
value is itself the duration.

### Retention

Defaults: raw 14 d, 1-minute 90 d, 1-hour 2 y, raw compressed after 7 d.

```sql
SELECT remove_retention_policy('system_metrics');
SELECT add_retention_policy('system_metrics', INTERVAL '30 days');
```

Sizing: roughly 3–5 KB per sample before compression → ~30 MB/server/day at 10 s,
falling by an order of magnitude once compression kicks in at 7 days.

### Backup

One database holds everything:

```bash
docker compose exec db pg_dump -U monit -Fc monit > monit-$(date +%F).dump
```

For TimescaleDB, prefer `pg_dump`/`pg_restore` over filesystem snapshots of a
running cluster.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Server stuck `offline` | `journalctl -u monit-agent`; then `curl -v $MONIT_API_URL/api/v1/health` from the host |
| Ingest 401 | key revoked or rotated — reissue and update the agent config |
| Ingest 403 | `MONIT_SERVER_ID` ≠ the registered `server_id` |
| Ingest 429 | interval too short, or two agents sharing one `server_id` |
| Charts empty but server online | wait one aggregate refresh (1 min), or query with `bucket=raw` |
| Alerts fire but nothing arrives | Settings → **Test** the channel; then `/notification-log` and `notification_dead_letter` |
| Notification stuck retrying | pg_boss retries 5× with backoff, then dead-letters; inspect `pgboss.job` |
| Migration warns about timescaledb | extension missing — the fallback views work, but install TimescaleDB for production |
| Intermittent `Server Offline` while the agent is clearly running | see below |

### Intermittent "Server Offline" on a host that is up

Liveness uses the central server's own clock (`last_seen = now()` at ingest), so
agent clock drift no longer causes this. Remaining causes, in order of how often
they turn up:

1. **The agent is not sending as often as you think.** In cron mode it is once a
   minute, which is past the 30 s offline threshold — the host will flap offline
   between samples. Either switch to loop mode, or raise `SAMPLE_INTERVAL_S` on
   the central server so the threshold (`3 ×`) covers the real cadence.

```bash
ssh -t <host> 'sudo /opt/monit/monit-config.sh -s'     # look at "service:"
```

2. **Samples are being rejected.** A revoked key (401), an ID that no longer
   matches (403), or rate limiting (429) all mean the agent runs happily while
   nothing lands. Check both ends:

```sql
SELECT server_id, now() - max(time) AS since_last FROM system_metrics GROUP BY 1 ORDER BY 2 DESC;
```

```bash
ssh <host> 'ls /var/lib/monit-agent/buffer | wc -l'    # >0 means sends are failing
```

3. **Two agents sharing one `server_id`** — they trip each other's rate limit.
   `pgrep -af monit-agent` on each host, and make sure only one of the systemd
   unit and the cron job exists.

4. **A slow collector inside the agent.** HTTP checks against an unresponsive
   endpoint cost up to 3 s each and push the effective interval out. Time it:

```bash
time bash /opt/monit/monit-agent.sh --print >/dev/null
```

If a large clock difference remains, the ingest log flags it — worth fixing
anyway, since the metric charts are plotted on the agent's timestamps:

```bash
docker compose -f docker-compose.app-only.yml logs app | grep 'sample timestamp is far'
```

### Self-monitoring

Point an agent at the monitoring host itself, and add HTTP checks for
`/api/v1/health`. Useful queries:

```sql
-- ingest lag per server
SELECT server_id, now() - max(time) AS lag FROM system_metrics GROUP BY 1 ORDER BY 2 DESC;

-- failed deliveries in the last hour
SELECT channel, count(*) FROM notification_log
WHERE NOT success AND created_at > now() - INTERVAL '1 hour' GROUP BY 1;

-- table sizes
SELECT hypertable_name, pg_size_pretty(hypertable_size(format('%I', hypertable_name)::regclass))
FROM timescaledb_information.hypertables;
```

---

## Using an existing PostgreSQL

The bundled `db` container is a convenience, not a requirement. To point at a
PostgreSQL you already run:

### 1. Create the database and role

```sql
CREATE ROLE monit LOGIN PASSWORD 'a-strong-password';
CREATE DATABASE monit OWNER monit;
```

Ownership matters: the app creates its own tables and pg_boss creates a
`pgboss` schema, so the role needs `CREATE` on the database. Superuser is not
required — verified against a plain `LOGIN` role that owns its database.

### 2. Point the app at it

```bash
# .env
DATABASE_URL=postgres://monit:a-strong-password@host.docker.internal:5432/monit
JWT_SECRET=...
ADMIN_EMAIL=you@company.com
ADMIN_PASSWORD=...

docker compose -f docker-compose.external-db.yml up -d --build
```

Use `host.docker.internal` when PostgreSQL runs on the Docker host, or the
server's IP when it runs elsewhere. Not using Docker at all works too:

```bash
cd server && npm ci && DATABASE_URL=... npm start
```

Migrations run on every boot and are idempotent, so there is no separate step.
To apply them without starting the app: `npm run migrate`.

### 3. Let the container reach the host database

PostgreSQL on the host must accept connections from Docker's bridge network:

```conf
# postgresql.conf
listen_addresses = '*'

# pg_hba.conf — Docker's default bridge subnet
host    monit    monit    172.16.0.0/12    scram-sha-256
```

Then `sudo systemctl reload postgresql`. Verify before starting the app:

```bash
docker run --rm --add-host host.docker.internal:host-gateway postgres:16-alpine \
  psql "postgres://monit:a-strong-password@host.docker.internal:5432/monit" -c 'SELECT 1'
```

### TimescaleDB on an existing server

The runner probes what actually works rather than trusting
`pg_available_extensions`, because the package is often installed while
`CREATE EXTENSION` still fails. Expect one of:

| Log line | Meaning |
|---|---|
| `timescaledb enabled` | full path — hypertable, continuous aggregates, compression, retention |
| `timescaledb is not installed on this server` | package absent; fallback views used |
| `timescaledb is installed but could not be enabled: …` | usually missing from `shared_preload_libraries` |

The fallback keeps every feature of the app working — `metrics_1m` /
`metrics_1h` become plain views computed on read instead of materialised
rollups. What you lose is automatic compression and retention, so
`system_metrics` grows until you prune it (~30 MB per server per day at a 10 s
interval):

```sql
DELETE FROM system_metrics WHERE time < now() - INTERVAL '14 days';
```

Queries also get slower on long ranges once the table is large, since the views
aggregate on demand.

To enable TimescaleDB on an existing server:

```bash
# after installing the package for your PG major version
sudo timescaledb-tune --quiet --yes     # adds it to shared_preload_libraries
sudo systemctl restart postgresql       # a restart is required, not a reload
```

Then restart the app. Already-migrated databases keep the fallback views —
`004_caggs.sql` is recorded as applied. To switch a live database over, drop the
two views and re-run that migration:

```sql
DROP VIEW metrics_1m, metrics_1h;
DELETE FROM schema_migrations WHERE filename IN ('004_caggs.sql','005_retention.sql');
```

Existing rows in `system_metrics` stay put, but the table is not retroactively
converted to a hypertable — see Timescale's `create_hypertable(...,
migrate_data => true)` if you need that.

---

## Pruning without TimescaleDB

`prune-metrics.sh` does what a retention policy would. Point cron at it:

```cron
30 3 * * * /opt/monit-server/prune-metrics.sh -d 14 >> /var/log/monit-prune.log 2>&1
```

It auto-detects the PostgreSQL container, deletes in batches so ingest writes
are never blocked behind one huge statement, and exits non-zero on failure so
cron mails you. `-N` counts without deleting; `-q` prints nothing unless
something breaks.

Companion tables are trimmed too — `notification_log` past 90 days (`-l`) and
resolved incidents past 365 (`-i`).

**On disk space:** a plain `DELETE` marks rows dead but does not shrink the
file; autovacuum makes that space reusable, so the table plateaus rather than
growing without bound. That is the right steady state for daily pruning. Pass
`-V` to `VACUUM` and hand space back to the filesystem — worth doing after a
one-off cut to a shorter retention, not on every nightly run.

Local mode (`-L`) uses `psql` on the host with `DATABASE_URL` from the
environment or `.env`, for when the database is not in a container.
