# Implementation decisions & deviations from the spec

`SYSTEM-REQUIREMENTS-AND-ARCHITECTURE.md` was implemented as written except
where it was internally inconsistent, referenced a dead service, or specified
something that does not execute. Each deviation is listed with its reason.

---

## 1. Deviations forced by defects in the spec

### 1.1 `metrics_1m` network rate — the SQL does not run

Spec §7.2:

```sql
(rate(network->'0'->>'rx_bytes'))[1] AS net_rx_bps
```

`rate()` in the Timescale Toolkit operates on a `counter_agg` accumulator, not
on a jsonb text extraction, and `network` is an *array* of interfaces, so
`->'0'` silently reads only the first one.

**Implemented:** the aggregate stores the counter (`max(net_counter_sum(...))`,
summed over interfaces via an IMMUTABLE helper so it is legal inside a
continuous aggregate) and the API differences consecutive buckets at query
time. Counter resets and long gaps yield `null`, breaking the line instead of
drawing a fabricated spike.

*Known limitation:* the aggregate sums across interfaces, so a host whose
interface set changes mid-window can show one distorted bucket. Per-interface
series on the raw path (≤3 h) are unaffected.

### 1.2 `projects.environment` CHECK constraint is a tautology

Spec §7.2: `CHECK (environment IN (...) OR environment <> ALL(ARRAY[...]))` is
true for every value. **Implemented:** the column is free text defaulting to
`'Dev'` — matching the spec's own §3.2 allowance for a custom label.

### 1.3 `servers.project_ids uuid[]` duplicated `server_projects`

Both existed in §7.2 for the same many-to-many relationship. **Implemented:**
the junction table `server_projects` only.

### 1.4 Alert units did not match agent output

| Spec rule | Agent actually sends | Resolution |
|---|---|---|
| `disk.avail_bytes < 5×1024³` | `avail_kb` | rule is `disk.avail_kb < 5242880` |
| `gpu.mem_used_pct` | `mem_used_mb` / `mem_total_mb` | derived server-side |
| `db.active_pct` | `active`, `max` | derived server-side |

### 1.5 `expected_running` had no storage

§6.1 alerts on "any expected PM2 app not online / any expected container not
running" but no table held the expectation. **Implemented:** `expected_services`
(server_id, kind, name), managed per server, feeding a `service_down` metric
that counts missing/not-running entries.

### 1.6 No `users` table

§3.1 requires JWT auth with four roles and an audit log; §7.2 has no `users`.
**Implemented:** `users` (bcrypt hashes, role enum) + `audit_log`. The spec's
fourth role, *Agent*, is a machine identity and remains `api_keys` — not a user.

### 1.7 Agent bugs in the reference implementation

| Bug | Fix |
|---|---|
| `"status_code":000` on connection failure — invalid JSON, rejects the whole sample | forced base-10 (`$((10#$code))`) → `0` |
| `exited = total - running` miscounts `paused`/`created`/`restarting` as exited | states counted individually from `docker ps -a` |
| `head -n $MONIT_DOCKER_MAX` truncated the stream *before* counting, so totals were capped too | counts computed over all containers; only the reported list is capped |
| `used=(a!=t)?t-a:0` — wrong guard; yields `t-a` even when `a > t` | `used=(a<=t)?t-a:0` |
| `uname -srmo` — `-o` is not POSIX, absent on some systems | `uname -srm` |
| `flush_buffer` only ran in cron mode, so loop mode never drained its backlog | drains after any successful send |
| `curl` without `-f` treats a 4xx/5xx response as success and drops the sample | `curl -fsS` |
| no `databases` collector despite §5.2 defining the payload | MySQL + PostgreSQL collectors added, off by default |

---

## 2. Choices made where the spec offered options

| Decision | Choice | Reason |
|---|---|---|
| Dashboard framework | **Vue 3** + Vite + Pinia | requested; spec allowed Angular/React/Vue |
| Job queue | **pg_boss** | no Redis to operate — the database is already the source of truth |
| LINE channel | **Telegram** | Line Notify shut down in 2025; Telegram Bot API needs only a token + chat id |
| Ingest/query split | **one process** | simpler to operate at the spec's 100-server target; routes are separate modules and split cleanly when needed |
| Dashboard hosting | served by the API from `public/` | one origin, no CORS or second deployment |

---

## 3. Additions beyond the spec

- **Plain-PostgreSQL fallback** — migrations detect a missing `timescaledb`
  extension and create equivalent views, so the stack boots on any Postgres.
- **Rate gap guard** — counter rates are suppressed across outages and resets.
- **Per-core CPU as a de-emphasized ensemble** — a 32-core host would need 33
  distinct series; cores render as one muted band under the `total` line, with
  the tooltip collapsing them to a min–max range. Keeps every chart inside an
  8-slot colorblind-validated palette.
- **One unit per chart** — the spec's §3.5 "RAM: Total/Used/Free/Cached + used_pct"
  would put percent and bytes on a single axis. Percent moved to a stat tile;
  the chart is GB-only. Same reason GPU utilization and VRAM are separate charts.
- **Reminders and auto-un-silence** in the alert lifecycle.
- **`GET /api/v1/servers/:id/series`** — multi-series endpoint for the detail
  charts, alongside the spec's single-metric `/metrics`.

---

## 4. Deliberately not built (spec §1.3 non-goals, plus)

Log aggregation, distributed tracing, APM, Windows agents, IPMI. Also deferred:
HA/replica topology (§2.4 — single-node compose ships here), systemd-unit and
raw-PID checks (§5.1 lists them as optional extensions), and CSV export.
