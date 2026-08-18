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

### Key rotation

Dashboard → server → **Rotate key**, or `POST /servers/:id/keys/rotate`. The old
key is revoked immediately — update `/etc/monit/agent.conf` and
`systemctl restart monit-agent`. Samples buffer on disk meanwhile (up to
`MONIT_BUFFER_MAX`) but will be rejected with the stale key; they drop once the
buffer cap is hit.

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
