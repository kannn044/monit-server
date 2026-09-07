# API reference

Base path `/api/v1`. JSON in, JSON out. Times are UTC ISO-8601.
Errors use `application/problem+json`: `{ "title", "status", "detail" }`.

Auth: dashboard routes take `Authorization: Bearer <JWT>`; the ingest route
takes a per-server agent key in the same header. Roles are hierarchical —
admin ⊃ operator ⊃ viewer.

---

## Ingestion

### `POST /api/v1/ingest` — agent key

Body: the agent payload (§4.4 of the spec). Required: `server_id`, `timestamp`.
The `server_id` must belong to the presented key.

```bash
curl -X POST https://monitor.example.com/api/v1/ingest \
  -H "Authorization: Bearer sk_agent_9f8e7d6c5b4a" \
  -H "Content-Type: application/json" \
  -d '{"server_id":"web-prod-01","timestamp":"2026-08-17T10:00:00Z",
       "cpu":{"total":42.5,"cores":[{"id":"0","used":30.1}]},
       "ram":{"total_kb":16777216,"used_kb":8388608,"used_pct":50.0},
       "disk":[{"mount":"/","device":"/dev/sda1","size_kb":104857600,
                "used_kb":52428800,"avail_kb":52428800,"used_pct":50.0}],
       "network":[{"iface":"eth0","rx_bytes":987654321,"tx_bytes":123456789}],
       "load":{"1m":2.15,"5m":1.8,"15m":1.4,"cores":8},
       "gpu":[],"docker":{"present":false},"pm2":{"present":false},"http":[]}'
# → 202 {"accepted":true}
```

| Status | Meaning |
|---|---|
| 202 | stored |
| 400 | schema violation or unusable timestamp |
| 401 | unknown / revoked key |
| 403 | `server_id` does not match the key |
| 429 | per-server rate limit exceeded |

Old timestamps are accepted (buffered backlog); `last_seen` only moves forward.

---

## Auth

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | `{email,password}` → access + refresh token |
| POST | `/auth/refresh` | — | `{refresh_token}` → new access token |
| GET | `/auth/me` | viewer | current identity |
| GET | `/users` | admin | list |
| POST | `/users` | admin | `{email,password,name,role}` |
| PATCH | `/users/:id` | admin | `{name?,role?,disabled?,password?}` |

## Roles

Three roles, each a superset of the one before it (`viewer` < `operator` < `admin`).

| | viewer | operator | admin |
|---|---|---|---|
| Read everything — fleet, servers, charts, rules, incidents, notification log | ✅ | ✅ | ✅ |
| Acknowledge / resolve / silence incidents | | ✅ | ✅ |
| **Register a server, edit it, move it between groups, set expected services** | | ✅ | ✅ |
| Rotate an agent key · delete or restore a server | | | ✅ |
| Create / archive groups · alert rules · notification channels | | | ✅ |
| Manage users | | | ✅ |
| Change **your own** password | ✅ | ✅ | ✅ |

Where the operator line is drawn, and why:

- **Onboarding is routine, removal is not.** `DELETE /servers/:id?purge=1` erases
  every stored sample for a server and cannot be undone, and
  `keys/rotate` stops a running agent the instant it is pressed — neither
  belongs to the role whose job is adding machines.
- **Re-registering a *deleted* id is an undelete**, not a create, so an operator
  posting an archived id gets a 403 explaining that an admin must restore or
  erase it. A brand-new id is created normally.
- Operators can put servers into groups but not create or archive the groups
  themselves.
- Every server action is written to `audit_log` with the acting user's email, so
  operator activity is attributable.

Two things worth knowing when you hand someone the operator role: a new server
inherits the `scope: all` alert rules, which are wired to your notification
channels — so a misconfigured host can page the on-call channel. And the
plaintext agent key is shown once at registration; if it is lost, only an admin
can issue a replacement.

### Sessions

Access tokens last 15 minutes and refresh tokens 7 days, and both carry a `tv`
claim holding the account's `token_version`. Every authenticated request
re-checks it against the database, so:

- changing a password (your own, or an admin resetting yours) bumps
  `token_version` and **ends every other session immediately** — the 7-day
  refresh window does not outlive the old password;
- disabling an account signs it out at once rather than whenever its token
  happens to expire;
- a role change applies to the session already open.

Agent ingest authenticates with a hashed API key and does not go through this
path, so the write path is unaffected.

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/change-password` | viewer | `{current_password, new_password}` — the current one is required, and a fresh token pair comes back so the caller stays signed in |
| DELETE | `/users/:id` | admin | hard delete; refuses your own account and the last active admin |

`PATCH /users/:id` also refuses to demote or disable the last active admin —
losing it would leave nobody able to manage users, rules or channels.

## Servers

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/servers` | viewer | `?project=&env=&status=` — includes computed `health`. `?archived=only` lists deleted servers, `?archived=all` lists both |
| POST | `/servers` | **operator** | `{id,name,ip?,project_ids?}` → **returns `api_key` once**. An id belonging to a *deleted* server is restored (`revived: true`); only a live id is a 409 |
| GET | `/servers/:id` | viewer | detail + latest sample + expected services |
| GET | `/servers/:id/summary` | viewer | latest values + derived net rate |
| PATCH | `/servers/:id` | **operator** | `{name?,ip?,project_ids?}` |
| DELETE | `/servers/:id` | admin | archive: revoke keys, close alerts, hide it — history kept, id restorable |
| DELETE | `/servers/:id?purge=1` | admin | erase: row, keys, alerts and every stored sample are deleted; the id is free |
| POST | `/servers/:id/restore` | admin | un-archive an archived server, return a new key once |
| POST | `/servers/bulk/group` | **operator** | `{server_ids:[...], project_id: uuid\|null}` — move many servers into one group; membership is **replaced**, `null` clears it |
| POST | `/servers/:id/keys/rotate` | admin | revoke old, return new key once |
| POST | `/servers/:id/expected-services` | **operator** | `{kind:"docker"\|"pm2", name}` |
| DELETE | `/servers/:id/expected-services/:esId` | **operator** | |

`health` is `online` · `warning` · `critical` · `offline`, where offline means no
sample for more than `SAMPLE_INTERVAL_S × 3`. Deleted servers report `archived`
and are excluded from every dashboard query.

### Agent keys cannot be read back

Only the SHA-256 hash of a key is stored, so there is no endpoint — and no
screen — that can show an existing key again. A lost key is *replaced*, never
recovered: `POST /servers/:id/keys/rotate` (**New key** in the dashboard) issues
a new one and revokes the old immediately. Deleting a server and re-registering
it under the same id also issues a new key, which is the path a forgotten key
used to be worked around with.

## Projects — "Groups" in the dashboard

The dashboard calls a project a **Group**: one concept, one word on screen. The
API and database keep the name `projects` / `server_projects`, so nothing here
changed. A group also carries an `environment` label (Prod / UAT / Dev), which
the Fleet page can group by instead.

**A server belongs to exactly one group.** The join table is many-to-many and
the API still accepts an array, but every screen writes a single id (or an empty
array for "Ungrouped"), and `/servers/bulk/group` replaces rather than appends.
Archiving a group leaves its servers registered — they simply become Ungrouped.


`GET /projects` (viewer) · `POST /projects` · `PUT /projects/:id` ·
`DELETE /projects/:id` (admin, archives) · `GET /projects/:id/overview` (viewer —
member servers, health counts, 15-minute average CPU/RAM).

## Metrics

### `GET /servers/:id/metrics` — single series

`metric` · `from` · `to` · `agg=avg|max|min` · `bucket=raw|1m|1h`
(bucket auto-selects from the span: ≤1 h raw, ≤48 h 1m, else 1h).

```bash
curl -G https://monitor.example.com/api/v1/servers/web-prod-01/metrics \
  -H "Authorization: Bearer <JWT>" \
  --data-urlencode "metric=cpu.total" \
  --data-urlencode "from=2026-08-17T00:00:00Z" \
  --data-urlencode "to=2026-08-17T10:00:00Z"
```

```json
{ "server_id":"web-prod-01","metric":"cpu.total","unit":"percent",
  "bucket":"1m","agg":"avg",
  "points":[{"t":"2026-08-17T09:59:00Z","v":43.8},{"t":"2026-08-17T10:00:00Z","v":42.5}] }
```

Metric paths: `cpu.total`, `ram.used_pct`, `ram.free_kb`, `ram.available_kb`,
`disk.used_pct` (worst mount), `disk.avail_kb` (tightest mount), `load.1m|5m|15m`,
`uptime_s`, `gpu.util_pct`, `gpu.mem_used_pct`, `net.rx_bps`, `net.tx_bps`,
`docker.running`, `pm2.online`, `http.status_code`, `http.latency_ms`,
`db.active`, `db.active_pct`, `service_down`, `no_sample`,
`ndb.nodes_unhealthy`, `ndb.data_nodes_started`, `ndb.data_nodes_configured`,
`ndb.node_groups_down`, `ndb.data_memory_pct`, `ndb.index_memory_pct`,
`ndb.arbitrator_connected`.

A `null` point is a real gap (missing sample, counter reset, or a span too long
to interpolate) — plot it as a break, not as zero.

The same rule applies to the app-level blocks in a sample. `docker` and `pm2`
carry an `accessible` flag; when it is `false` the agent could not read that
daemon, so `running` / `online` are `null` rather than `0`. Alert evaluation
skips those metrics entirely — an unreadable daemon must never be scored as an
outage — and `service_down` returns `null` when it had nothing it could check.

### `GET /servers/:id/series` — multi-series for charts

`kind=cpu|ram|disk|net|load|gpu|gpuvram`, plus `from`/`to`. Returns
`{ series: { name: [{t,v}] } }`. Every series inside one `kind` shares one unit.
Spans ≤3 h return per-core / per-mount / per-interface / per-GPU detail; longer
spans return aggregated series.

### `GET /fleet/health`

KPI counts and all servers with health, each carrying `current` (the newest raw
sample: cpu, ram, disk, disk_avail_kb, disk_size_kb, load_1m, cores, uptime_s),
plus the 10 most recent incidents and per-project rollups.

`top` (top-5 by CPU/RAM/disk/load) and `sparkline_24h` are **opt-in**:

```
GET /fleet/health?include=top,sparkline
```

They are excluded by default because the Fleet page polls this endpoint every
10 seconds and renders neither. The sparkline in particular aggregated 24 hours
of raw samples through the `metrics_1m` view — which on plain PostgreSQL is a
view, not a materialised rollup, so it scanned the whole of `system_metrics`
(measured: 1.6 s over 1.7 M rows, and growing with retention). With it excluded
the endpoint answers in ~5 ms for a 14-server fleet.

## Alerting

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/alerts` | viewer | active incidents; `?severity=&project=` |
| GET | `/incidents` | viewer | history; `?status=&severity=&server=&project=&from=&to=&page=&limit=` |
| POST | `/alerts/:id/ack` | operator | `{notes?}` |
| POST | `/alerts/:id/resolve` | operator | `{notes?}` |
| POST | `/alerts/:id/silence` | operator | `{minutes}` — auto-expires |
| GET | `/alert-rules` | viewer | |
| POST | `/alert-rules` | admin | |
| PUT | `/alert-rules/:id` | admin | |
| DELETE | `/alert-rules/:id` | admin | |
| GET | `/channels` | viewer | secrets omitted for non-admins |
| POST/PUT/DELETE | `/channels[/:id]` | admin | |
| POST | `/webhooks/test` | admin | `{channel}` — sends a test message |
| GET | `/notification-log` | viewer | last 200 deliveries |

Rule body:

```json
{ "name":"High RAM", "metric":"ram.used_pct", "comparator":">", "threshold":90,
  "duration_min":3, "recover_threshold":85, "severity":"critical",
  "scope_type":"project", "scope_ids":["<uuid>"],
  "channels":["oncall-telegram"], "enabled":true,
  "flap_limit":5, "flap_window_min":30 }
```

Channel config by type — `telegram`: `{bot_token, chat_id}` ·
`slack`: `{webhook_url}` · `webhook`: `{url, headers?}`.

Outgoing notification payload:

```json
{ "event":"alert.fired", "incident_id":"inc_20260817_a3f9c1", "rule_name":"High RAM",
  "severity":"critical", "server_id":"web-prod-01", "project":"Checkout Service",
  "environment":"Prod", "metric":"ram.used_pct", "comparator":">",
  "value":93.4, "threshold":90, "duration_min":3,
  "started_at":"2026-08-17T10:03:00Z",
  "message":"High RAM: ram.used_pct = 93.40 (> 90) on Web Prod 01 for 3 min" }
```

`event` is `alert.fired` · `alert.resolved` · `alert.reminder` · `alert.flapping` · `test`.

## System

`GET /api/v1/health` — unauthenticated liveness probe.
