# Server Monitoring System
## System Requirements & Architecture Document

| Field            | Value                                             |
| ---------------- | ------------------------------------------------- |
| **Document ID**  | `SRS-ARCH-MONIT`                                  |
| **Version**      | `1.0.0`                                           |
| **Status**       | Draft — Ready for Review                          |
| **Author**       | DevOps / System Architecture                      |
| **Last Updated** | 2026-08-17                                        |
| **Audience**     | Backend, Frontend, DevOps, SRE, Security          |

---

## Table of Contents

1. [Introduction & Scope](#1-introduction--scope)
2. [System Overview & Architecture](#2-system-overview--architecture)
3. [Web Dashboard & UI Requirements](#3-web-dashboard--ui-requirements)
4. [Monitoring Agent (Shell) Specification](#4-monitoring-agent-shell-specification)
5. [Application & Stack-Specific Monitoring](#5-application--stack-specific-monitoring)
6. [Alerting & Notification System](#6-alerting--notification-system)
7. [API Design & Data Storage](#7-api-design--data-storage)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Implementation Roadmap](#9-implementation-roadmap)
10. [Appendices](#10-appendices)

---

## 1. Introduction & Scope

### 1.1 Purpose

This document defines the requirements and architecture for a **custom, self-hosted Server Monitoring System**. The system provides centralized, real-time and historical observability for a fleet of heterogeneous servers spanning multiple projects and environments (Production, UAT, Development).

The primary goal is a **low-footprint, push-based** design: a lightweight agent on each target server periodically pushes a structured metrics payload to a central ingestion service, which stores the data in a time-series store, evaluates alerting rules, and exposes everything through a web dashboard.

### 1.2 Goals

- **Multi-project observability** — group and filter servers by **Project** and **Environment**.
- **Real-time + historical** — sub-minute freshness with long-term retention and downsampling.
- **Heterogeneous stack coverage** — Frontend, Backend, Databases, Docker, and multi-GPU hosts.
- **Lightweight agent** — a single bash script, minimal CPU/RAM, safe to run every 10 seconds.
- **Resilient** — agents must not crash or exhaust local resources if the central server is unreachable.
- **Actionable alerting** — configurable thresholds with sustained-duration logic and multi-channel notifications.
- **Self-contained & portable** — deployable on any Linux server with common coreutils.

### 1.3 Non-Goals (Out of Scope for v1)

- Log aggregation / centralized logging (ELK/Loki) — *future phase*.
- Distributed tracing (OpenTelemetry/Jaeger) — *future phase*.
- APM-level code instrumentation (per-endpoint latency p95 from app internals).
- Windows agent support (v1 targets **Linux** hosts only).
- Hardware/IPMI-level sensor monitoring.

### 1.4 Target Environments Matrix

The monitored fleet includes the following technology stacks. The agent and dashboard must be aware of each.

| Layer      | Technologies                                      | Monitoring Focus                                  |
| ---------- | ------------------------------------------------- | ------------------------------------------------- |
| **Frontend**   | Angular, Next.js, Vue                            | HTTP health of the serving process, CPU/RAM       |
| **Backend**    | Node.js (Express, Fastify), Python, Jupyter      | Process liveness, HTTP health, CPU/RAM, DB conns  |
| **Database**   | MySQL, PostgreSQL                                 | Active connections, replication, disk             |
| **Containers** | Docker                                          | Container running state, per-container resources  |
| **Compute**    | Multi-GPU (NVIDIA) hosts                        | GPU/VRAM utilization, temperature, power          |

### 1.5 Assumptions & Conventions

- Target servers run **Linux** (procfs available: `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/uptime`, `/proc/loadavg`).
- `curl`, `awk`, `df`, `grep`, `date`, `hostname` are present on all agents (coreutils).
- `jq` is a **soft dependency** (used for rich PM2 parsing; a fallback is provided when absent).
- `docker` and `pm2` are **optional** — the agent gracefully reports `present: false` when absent.
- `nvidia-smi` is present only on GPU hosts.
- All agents authenticate with a **per-server Bearer token**.
- Time is exchanged in **UTC ISO-8601** (`2026-08-17T10:00:00Z`).

### 1.6 Glossary

| Term             | Definition                                                        |
| ---------------- | ----------------------------------------------------------------- |
| **Agent**        | The bash script running on each target server.                    |
| **Ingestion API**| Central HTTPS endpoint that receives agent payloads.             |
| **Sample**       | One metrics payload from one server at one point in time.        |
| **Gauge**        | A metric that can go up and down (e.g., CPU %, free RAM).        |
| **Counter**      | A monotonically increasing value (e.g., network bytes sent).     |
| **Rule**         | A threshold condition that can raise an alert.                   |
| **Incident**     | A period during which a rule is in the `firing` state.           |

---

## 2. System Overview & Architecture

### 2.1 High-Level Architecture

```mermaid
flowchart LR
  subgraph TS["Target Servers (Linux fleet)"]
    A["monit-agent.sh<br/>(cron or loop, 10s)"]
  end

  subgraph CS["Central Monitoring Server"]
    IN["Ingestion API<br/>(Fastify / Express)"]
    VAL["Validate · Normalize<br/>(schema, auth, rate-limit)"]
    TSDB[("Time-Series DB<br/>TimescaleDB<br/>(metrics)")]
    REL[("Relational DB<br/>PostgreSQL<br/>(metadata, rules, incidents, users)")]
    AE["Alert Engine<br/>(threshold + duration state machine)"]
    NS["Notification Service<br/>(Webhook · Slack · Line Notify)"]
    API["Query REST API<br/>/api/v1/*"]
  end

  UI["Web Dashboard<br/>(Angular / React / Vue)"]

  A -- "HTTPS + Bearer Token" --> IN
  IN --> VAL
  VAL --> TSDB
  VAL --> REL
  TSDB --> AE
  REL --> AE
  AE --> NS
  NS -.->|webhook| EXT["Slack / Line / 3rd-party"]
  TSDB --> API
  REL --> API
  API --> UI
```

### 2.2 Component Responsibilities

| Component              | Responsibility                                                                                     | Tech (suggested)                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Agent**              | Collect system + app metrics; build JSON; push with auth; buffer on failure.                         | Bash + curl + procfs                 |
| **Ingestion API**      | Terminate TLS; authenticate; validate payload schema; rate-limit; write to DB.                       | Fastify (Node 20) or Express         |
| **Time-Series DB**     | Store high-frequency samples; retention, compression, continuous aggregates.                         | **TimescaleDB** (PostgreSQL ext.)    |
| **Relational DB**      | Servers, projects, users, alert rules, incidents, API keys.                                          | PostgreSQL 15                        |
| **Alert Engine**       | Evaluate rules on fresh data; manage alert lifecycle; debounce; dispatch.                            | Node worker (BullMQ / pg_boss)       |
| **Notification Service**| Render templates; deliver to Webhook / Slack / Line; retry + dead-letter.                           | Node worker                          |
| **Query API**          | Serve dashboard data: server lists, metric series, aggregates, incidents.                            | Fastify / Express                    |
| **Dashboard UI**       | Project views, server detail, charts, alert management, settings.                                    | Angular 17 (or React/Vue)            |

### 2.3 Data Flow (Sequence)

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent (target server)
  participant I as Ingestion API
  participant D as TimescaleDB
  participant R as PostgreSQL (meta)
  participant E as Alert Engine
  participant N as Notifier
  participant U as Dashboard

  loop every 10s
    A->>I: POST /api/v1/ingest (Bearer key, JSON sample)
    I->>I: auth + schema validate + rate-limit
    I->>D: INSERT sample (metrics)
    I->>R: UPSERT servers.last_seen
    I-->>A: 202 Accepted
  end

  Note over E: on each ingest / every 30s tick
  E->>D: query latest window (e.g. 3 min)
  E->>E: evaluate rules + duration state machine
  E->>R: upsert incidents (firing/resolved)
  E->>N: dispatch notification (throttled)
  N->>N: Slack / Line / Webhook

  U->>I: GET /api/v1/servers, /api/v1/servers/:id/metrics
  I->>D: query series (continuous aggregates)
  I-->>U: JSON
```

### 2.4 Deployment Topology

```mermaid
flowchart TB
  subgraph K8s["Optional: Central cluster (Docker / K8s)"]
    direction LR
    ING["ingestion-api (x2, HA)"]
    API["query-api (x1+)"]
    WORKER["alert-worker (x1)"]
    NOTIF["notif-worker (x1)"]
    PG[("TimescaleDB<br/>primary + replica")]
  end
  subgraph OnPrem["Target servers"]
    S1["server-01 (prod)"]
    S2["server-02 (gpu)"]
    S3["server-03 (dev)"]
  end
  S1 -- HTTPS 443 --> ING
  S2 -- HTTPS 443 --> ING
  S3 -- HTTPS 443 --> ING
  ING --> PG
  API --> PG
  WORKER --> PG
  NOTIF --> PG
  WEB["Browser / Dashboard"] --> API
```

> **HA note:** The central tier (ingestion, query, workers, DB) is stateless except for the database and can be horizontally scaled behind an L7 load balancer. The DB is the single source of truth and should run with at least one streaming replica.

### 2.5 Technology Stack Summary

| Concern            | Choice                                   | Rationale                                       |
| ------------------ | ---------------------------------------- | ----------------------------------------------- |
| Agent              | Bash + curl + procfs                     | Zero-install, portable, tiny footprint          |
| Ingestion/Query    | Node.js 20 + Fastify                     | Single language for API + workers, fast         |
| Time-series        | **TimescaleDB** (PostgreSQL 15)          | SQL, Postgres ecosystem, hypertables, aggregates|
| Metadata           | PostgreSQL 15                            | Same engine as Timescale (one database)         |
| Job queue          | BullMQ (Redis) or pg_boss                | Alert + notification workers                    |
| Dashboard          | Angular 17 + Nx (or React/Vue)           | Team familiarity; component-based               |
| Auth               | JWT (UI) + Bearer API keys (agents)      | Separation of UI users vs. machine identity     |
| Reverse proxy      | Caddy / Nginx                            | TLS termination for the central tier            |

---

## 3. Web Dashboard & UI Requirements

### 3.1 Roles & Access Control

| Role        | Capabilities                                                              |
| ----------- | ------------------------------------------------------------------------- |
| **Viewer**  | View projects, servers, metrics, incidents (read-only).                   |
| **Operator**| Viewer + acknowledge/resolve incidents, test notifications.               |
| **Admin**   | Operator + manage projects, servers, alert rules, users, API keys, webhooks. |
| **Agent**   | Machine identity (API key) — can only `POST /api/v1/ingest`.              |

- Authentication: email/password → **JWT** (access + refresh). Role-based authorization enforced server-side on every route.
- Audit log for admin actions (who changed which rule, when).

### 3.2 Project / Group Management

- Create, edit, delete **Projects** (e.g., `Checkout Service`, `ML Training`).
- Each project has an **Environment** tag: `Prod` | `UAT` | `Dev` (or a custom label).
- Servers are **assigned to one or more projects** (many-to-many allowed; a server may serve multiple projects).
- Grouping/filters available on every screen: by Project, by Environment, and combined.
- Bulk operations: move servers between projects, archive a project (soft-delete).

### 3.3 High-Level (Fleet) View

A landing dashboard summarizing the whole fleet:

| Widget                                   | Details                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| **KPI cards**                            | Total servers · Online · Offline · Degraded (warn) · Critical (alert). |
| **Health matrix**                        | Grid of servers, color-coded (green/yellow/red/gray) by health.        |
| **Project summary table**                | Per project: server count, online count, open critical alerts.         |
| **Top-N**                                | Top 5 CPU, Top 5 RAM, Top 5 Disk, Highest load — quick triage.         |
| **Alert ticker**                         | Most recent critical/warning alerts with age + link to incident.       |
| **Trend sparklines**                     | Fleet-wide CPU/RAM/Disk over last 24h (downsampled).                    |

- **Health definition** (computed server-side):
  - `offline` — no sample received for **> 3 × interval** (default 30 s).
  - `critical` — any active `critical` incident.
  - `warning` — any active `warning` incident (no critical).
  - `online` — recent sample, no active incidents.

### 3.4 Server Detail View

Drill-down for a single server:

- **Header** — name, project(s), environment, IP, OS, uptime, last-seen, health badge, GPU presence.
- **Time-range selector** — 15 min / 1 h / 6 h / 24 h / 7 d / 30 d / custom.
- **Real-time panel** — auto-refreshing (10 s) gauges for CPU, RAM, Disk, Net.
- **Historical charts** — one per metric family (see 3.5), with hover tooltips and zoom.
- **App health section** — Docker containers, PM2 processes, HTTP endpoint checks (pass/fail + latency).
- **Incident history** — incidents for this server with timeline.
- **Actions** — view raw samples, export CSV, edit assignment, rotate API key.

### 3.5 Core Metrics Visualization

| Metric            | Breakdown                                   | Chart Type            | Notes                                    |
| ----------------- | ------------------------------------------- | --------------------- | ---------------------------------------- |
| **CPU**           | Per-core usage + overall total              | Multi-line / stacked  | `cpu.cores[]` + `cpu.total`              |
| **RAM**           | Total / Used / Free / Cached / Buffers      | Area (stacked)        | Show `used_pct` as gauge                 |
| **Disk**          | Per-partition used vs. available            | Stacked bar / gauge   | One series per mount                     |
| **Network I/O**   | Rx / Tx rate (bytes/s)                      | Dual area             | Rate computed server-side from counters  |

### 3.6 Extended Metrics

| Metric                 | Breakdown                          | Chart Type        | Condition              |
| ---------------------- | ---------------------------------- | ----------------- | ---------------------- |
| **GPU**                | Utilization %, VRAM used/total     | Multi-line + gauge| Only if GPU present    |
| **VRAM**               | Per-GPU used / free (MB)           | Area              | Only if GPU present    |
| **GPU temp / power**   | °C, W per GPU                      | Line              | Optional               |
| **Load Average**       | 1m / 5m / 15m vs. core count       | Multi-line        | Always                 |
| **Uptime**             | Seconds (humanized)                | Gauge / text      | Always                 |

### 3.7 Alert & Incident View

- **Active incidents** — table: severity, server, project, metric, value, threshold, since, duration, status (`firing` / `acknowledged` / `resolved`), actions (acknowledge, resolve, silence).
- **Incident history** — filterable by project, severity, date range, status.
- **Rule builder** — form to create/edit alert rules (see §6).
- **Notification log** — last deliveries per channel with success/failure + response snippet.

### 3.8 Non-Functional UI Requirements

- **Performance** — initial dashboard < 2 s on a 50-server fleet; charts virtualized for long ranges.
- **Responsiveness** — desktop-first, usable on tablet; mobile read-only acceptable.
- **Accessibility** — WCAG 2.1 AA (contrast, keyboard nav, ARIA labels on charts).
- **Time handling** — display in the viewer's local timezone; store in UTC.
- **Empty/error states** — graceful "no data / agent offline" states; clear error banners.
- **i18n** — English first; structure for translation later.

---

## 4. Monitoring Agent (Shell) Specification

### 4.1 Design Principles

1. **Single file** — one `monit-agent.sh`, no build step, no runtime install.
2. **Lightweight** — target **< 5 MB RSS**, **< 2% CPU** per run; safe at a 10 s interval.
3. **Stateless core** — no persistent state required for metrics (counters sent raw; server derives rates).
4. **Fail-safe** — **fire-and-forget** with a **bounded on-disk buffer**; never crash, never hang, never flood.
5. **Idempotent & safe** — read-only on the host (no `sudo`-mutating ops), non-blocking network with hard timeouts.
6. **Graceful degradation** — optional collectors (GPU/Docker/PM2/HTTP) skip cleanly when tools are absent.

### 4.2 Execution Model

Two mutually exclusive modes, selected by CLI flag or config:

| Mode       | Invocation                                                        | Use case                          |
| ---------- | ----------------------------------------------------------------- | --------------------------------- |
| **Cron**   | `* * * * * /opt/monit/monit-agent.sh >> /var/log/monit-agent.log 2>&1` | Simple, OS-managed, one-shot per tick |
| **Loop**   | `monit-agent.sh --loop --interval 10` (under systemd `Restart=always`) | Continuous, tight timing          |

- **Interval** is configurable (`MONIT_INTERVAL`, default `10` seconds).
- In **loop** mode the script traps `INT`/`TERM` for clean shutdown (systemd-friendly).
- In **cron** mode the script also attempts to flush a stale buffer (see 4.7) before the new sample.

### 4.3 Configuration

Configuration is via environment variables (or a sourced `/etc/monit/agent.conf`).

| Variable               | Default                       | Description                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------ |
| `MONIT_API_URL`        | `https://monitor.example.com` | Base URL of the central ingestion service.             |
| `MONIT_SERVER_ID`      | `$(hostname -s)`              | Stable unique ID for this server.                      |
| `MONIT_API_KEY`        | *(empty)*                     | Bearer token for authentication. **Required.**         |
| `MONIT_INTERVAL`       | `10`                          | Seconds between samples (loop mode).                   |
| `MONIT_TIMEOUT`        | `5`                           | `curl --max-time` (seconds).                           |
| `MONIT_CONNECT_TIMEOUT`| `2`                           | `curl --connect-timeout` (seconds).                    |
| `MONIT_BUFFER_DIR`     | `/var/lib/monit-agent/buffer` | Directory for the failure buffer.                      |
| `MONIT_BUFFER_MAX`     | `50`                          | Max buffered files (oldest dropped beyond this).       |
| `MONIT_NET_IFACES`     | `eth0`                        | Space-separated interfaces to report.                  |
| `MONIT_GPU`            | `auto`                        | `auto`/`1`/`0` — probe for `nvidia-smi`.               |
| `MONIT_HTTP_CHECKS`    | *(empty)*                     | Comma-separated local health URLs.                     |
| `MONIT_DOCKER_MAX`     | `100`                         | Cap on reported containers.                            |

> **Security:** `MONIT_API_KEY` should live in a root-only file (e.g. `/etc/monit/agent.conf`, `0600`) or a systemd `EnvironmentFile`, **not** in a world-readable script or in `crontab` plaintext.

### 4.4 Payload JSON Schema

The agent sends a single JSON object per sample. Field types and semantics:

```jsonc
{
  "server_id":  "web-prod-01",            // string, required
  "timestamp":  "2026-08-17T10:00:00Z",   // string, UTC ISO-8601, required
  "hostname":   "web-prod-01",            // string
  "os":         "Linux 5.15.0-91 x86_64", // string
  "uptime_s":   1234567,                  // number (counter, seconds)
  "cpu": {
    "total": 42.5,                        // number, % (gauge)
    "cores": [                            // array of per-core (gauge)
      { "id": "0", "used": 30.1 },
      { "id": "1", "used": 55.2 }
    ]
  },
  "ram": {
    "total_kb": 16777216,                 // number (bytes→KB)
    "used_kb": 8388608,
    "free_kb": 2097152,
    "available_kb": 6291456,
    "buffers_kb": 524288,
    "cached_kb": 4194304,
    "used_pct": 50.0,                     // number (gauge)
    "swap_total_kb": 2097152,
    "swap_free_kb": 1572864
  },
  "disk": [                               // array, one per real filesystem
    {
      "mount": "/",
      "device": "/dev/sda1",
      "size_kb": 104857600,
      "used_kb": 52428800,
      "avail_kb": 52428800,
      "used_pct": 50.0
    }
  ],
  "network": [                            // array, CUMULATIVE COUNTERS (server derives rate)
    { "iface": "eth0", "rx_bytes": 987654321, "tx_bytes": 123456789 }
  ],
  "load": { "1m": 2.15, "5m": 1.80, "15m": 1.40, "cores": 8 },
  "gpu": [                                // empty [] when no GPU
    {
      "id": 0,
      "name": "NVIDIA A100 80GB",
      "util_pct": 78.0,
      "mem_total_mb": 81920,
      "mem_used_mb": 61440,
      "mem_free_mb": 20480,
      "temp_c": 62,
      "power_w": 240.5
    }
  ],
  "docker": {
    "present": true,
    "total": 6,
    "running": 5,
    "exited": 1,
    "containers": [ { "name": "api", "state": "running", "status": "Up 3 hours" } ]
  },
  "pm2": {
    "present": true,
    "online": 4,
    "stopped": 1,
    "processes": [ { "name": "checkout-api", "status": "online", "pid": 4242 } ]
  },
  "http": [                               // local endpoint health checks
    { "url": "http://127.0.0.1:3000/health", "status_code": 200, "latency_ms": 12 }
  ]
}
```

**Metric kind table**

| Field            | Kind    | Unit      | Notes                                          |
| ---------------- | ------- | --------- | ---------------------------------------------- |
| `cpu.total`      | gauge   | %         | Overall CPU utilization.                       |
| `cpu.cores[].used`| gauge   | %         | Per-core utilization.                          |
| `ram.*`          | gauge   | KB / %    | `used = total - available` (top-style).        |
| `disk[]`         | gauge   | KB / %    | One entry per real partition.                  |
| `network[]`      | counter | bytes     | Cumulative; **server** computes bytes/s rate.  |
| `load.*`         | gauge   | —         | Load average vs. core count.                   |
| `uptime_s`       | counter | seconds   | Resets on reboot.                              |
| `gpu[]`          | gauge   | %/MB/°C/W | Empty array when no GPU.                       |
| `docker`, `pm2`  | gauge   | —         | Liveness + counts + per-item state.            |
| `http[]`         | gauge   | code/ms   | Status code + latency of local checks.         |

### 4.5 Data Collection (per metric)

| Metric       | Source / Command                                   |
| ------------ | -------------------------------------------------- |
| CPU (total + per-core) | Two `/proc/stat` snapshots ~1 s apart; delta of idle vs. total. |
| RAM           | `/proc/meminfo` (`MemTotal`, `MemAvailable`, `MemFree`, `Buffers`, `Cached`, `SwapTotal`, `SwapFree`). |
| Disk          | `df -kP`, filtering pseudo filesystems.            |
| Network       | `/proc/net/dev` (fields 2 = rx_bytes, 10 = tx_bytes). |
| Load / cores  | `/proc/loadavg`, `nproc`.                          |
| Uptime        | `/proc/uptime`.                                    |
| GPU           | `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`. |
| Docker        | `docker ps -aq`, `docker ps -a --format ...`.      |
| PM2           | `pm2 jlist` (with `jq`) or `pm2 list` fallback.    |
| HTTP checks   | `curl -s -o /dev/null -w '%{http_code} %{time_total}' <url>`. |

### 4.6 Authentication

- Every request carries `Authorization: Bearer <MONIT_API_KEY>`.
- The **Ingestion API** verifies the key against a hashed value stored in `api_keys`, enforces that the key's scope permits `ingest`, and maps the key → `server_id` (the server is only allowed to report its own identity; a mismatch is rejected).
- Transport is **TLS-only** (HTTPS). Plaintext HTTP is rejected at the reverse proxy.
- Keys can be **rotated** and **revoked** from the dashboard (Admin).

### 4.7 Fail-Safe & Buffering

The network call is a **non-blocking, hard-timeout** operation. The design guarantees the agent never hangs the host or grows unbounded memory.

**Send logic (each run):**

```
1. Build the current sample (JSON).
2. Try to send it (curl with --max-time and --connect-timeout).
   ├─ SUCCESS → central is up.
   │          └─ Opportunistically flush up to N buffered samples
   │             (drain backlog; delete files on 2xx).
   └─ FAILURE → central is down.
              └─ Write the sample to the on-disk buffer.
                 Enforce MONIT_BUFFER_MAX (drop oldest).
                 Continue (no crash, no retry storm).
```

**Properties:**

- **Bounded memory:** only one sample (a few KB) in memory at a time; backlog lives on disk, capped at `MONIT_BUFFER_MAX`.
- **Bounded time:** `curl` cannot exceed `MONIT_TIMEOUT` (default 5 s) per attempt.
- **No retry storm:** when the central is down, the agent buffers and moves on; it does **not** hammer the endpoint.
- **No crash:** all collectors are guarded (`command -v ...`); a missing tool yields a `present: false` / empty array, never a fatal error. `set -u` is on but commands are wrapped so a non-zero exit doesn't abort the script.

### 4.8 Reference Implementation (`monit-agent.sh`)

> A complete, production-ready reference. Requires only `bash`, `curl`, `awk`, `df`, `grep`, `date`, `hostname`. `jq`/`docker`/`pm2`/`nvidia-smi` are optional.

```bash
#!/usr/bin/env bash
#
# monit-agent.sh — Lightweight server metrics collector & shipper.
#
# Design: stateless, fire-and-forget, bounded on-disk buffer, hard timeouts.
# Modes : --loop --interval N   (continuous)   |   (default: one-shot / cron)
#
set -u
set -o pipefail

# ---------------------------------------------------------------------------
# Configuration (env overrides; see /etc/monit/agent.conf)
# ---------------------------------------------------------------------------
: "${MONIT_API_URL:=https://monitor.example.com}"
: "${MONIT_SERVER_ID:=$(hostname -s 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)}"
: "${MONIT_API_KEY:=}"
: "${MONIT_INTERVAL:=10}"
: "${MONIT_TIMEOUT:=5}"
: "${MONIT_CONNECT_TIMEOUT:=2}"
: "${MONIT_BUFFER_DIR:=/var/lib/monit-agent/buffer}"
: "${MONIT_BUFFER_MAX:=50}"
: "${MONIT_NET_IFACES:=eth0}"
: "${MONIT_GPU:=auto}"
: "${MONIT_HTTP_CHECKS:=}"
: "${MONIT_DOCKER_MAX:=100}"
: "${CPU_SAMPLE_S:=1}"

INGEST_URL="${MONIT_API_URL%/}/api/v1/ingest"

log() { printf '%s [monit-agent] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
json_escape() {
  local s=${1-}
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

# ---------------------------------------------------------------------------
# Collection functions (each prints a JSON fragment)
# ---------------------------------------------------------------------------
collect_cpu() {
  # Two /proc/stat snapshots ~CPU_SAMPLE_S apart; delta idle vs total per core.
  awk '
    FNR==NR { for (i=2;i<=8;i++) pt[$1]+=$i; pi[$1]=$5+$6; next }
    {
      dt=0; for (i=2;i<=8;i++) dt+=$i; dt-=pt[$1]
      di=($5+$6)-pi[$1]
      used=(dt>0)?100*(1-di/dt):0
      if ($1=="cpu") total=used
      else { gsub(/^cpu/,"",$1); cores=cores (cores==""?"":",") "{\"id\":\""$1"\",\"used\":"sprintf("%.2f",used)"}" }
    }
    END { printf "{\"total\":%.2f,\"cores\":[%s]}", total, cores }
  ' <(grep '^cpu' /proc/stat) <(sleep "$CPU_SAMPLE_S"; grep '^cpu' /proc/stat)
}

collect_ram() {
  awk '
    /^MemTotal:/     {t=$2}
    /^MemFree:/      {f=$2}
    /^MemAvailable:/ {a=$2}
    /^Buffers:/      {b=$2}
    /^Cached:/       {c=$2}
    /^SwapTotal:/    {st=$2}
    /^SwapFree:/     {sf=$2}
    END {
      used=(a!=t)?t-a:0
      pct=(t>0)?100*used/t:0
      printf "{\"total_kb\":%d,\"used_kb\":%d,\"free_kb\":%d,\"available_kb\":%d,\"buffers_kb\":%d,\"cached_kb\":%d,\"used_pct\":%.2f,\"swap_total_kb\":%d,\"swap_free_kb\":%d}", \
        t,used,f,a,b,c,pct,st,sf
    }
  ' /proc/meminfo
}

collect_disk() {
  local items
  items=$(df -kP 2>/dev/null | awk '
    NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|shm|udev|none|squashfs|udevtmpfs)/ {
      src=$1; size=$2; used=$3; avail=$4; pct=$5; sub(/%/,"",pct)
      if (size !~ /^[0-9]+$/) next   # skip pseudo/special filesystems (e.g. auto_home)
      m=$6; for (i=7;i<=NF;i++) m=m" "$i
      gsub(/\\/,"\\\\",m);  gsub(/"/,"\\\"",m)
      gsub(/\\/,"\\\\",src);gsub(/"/,"\\\"",src)
      printf "%s{\"mount\":\"%s\",\"device\":\"%s\",\"size_kb\":%s,\"used_kb\":%s,\"avail_kb\":%s,\"used_pct\":%s}", (n++?",":""), m, src, size, used, avail, pct
    }')
  printf '[%s]' "$items"
}

collect_net() {
  local out="" iface line rx tx
  for iface in $MONIT_NET_IFACES; do
    [ -z "$iface" ] && continue
    line=$(awk -v IF="$iface" 'NR>2 { name=$1; sub(/:$/,"",name); if (name==IF) print $2, $10 }' /proc/net/dev 2>/dev/null)
    [ -z "$line" ] && continue
    read -r rx tx <<< "$line"
    out="${out}${out:+,}{\"iface\":\"$(json_escape "$iface")\",\"rx_bytes\":$rx,\"tx_bytes\":$tx}"
  done
  printf '[%s]' "$out"
}

collect_load() {
  local l1 l5 l15 cores
  read -r l1 l5 l15 _ < /proc/loadavg
  cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
  printf '{"1m":%s,"5m":%s,"15m":%s,"cores":%s}' "$l1" "$l5" "$l15" "$cores"
}

collect_uptime() { awk '{printf "%.0f", $1}' /proc/uptime 2>/dev/null || echo 0; }

collect_gpu() {
  if [ "$MONIT_GPU" = "0" ] || ! command -v nvidia-smi >/dev/null 2>&1; then
    printf '[]'; return 0
  fi
  local items
  items=$(nvidia-smi \
      --query-gpu=index,name,utilization.gpu,memory.total,memory.used,memory.free,temperature.gpu,power.draw \
      --format=csv,noheader,nounits 2>/dev/null | awk -F',' '
    function num(x){ if (x ~ /^[0-9.]+$/) return x+0; return 0 }
    NF>=8 {
      name=$2; gsub(/^[ \t]+|[ \t]+$/,"",name)
      gsub(/\\/,"\\\\",name); gsub(/"/,"\\\"",name)
      printf "%s{\"id\":%s,\"name\":\"%s\",\"util_pct\":%s,\"mem_total_mb\":%s,\"mem_used_mb\":%s,\"mem_free_mb\":%s,\"temp_c\":%s,\"power_w\":%s}", \
        (n++?",":""), num($1), name, num($3), num($4), num($5), num($6), num($7), num($8)
    }')
  printf '[%s]' "$items"
}

collect_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf '{"present":false,"total":0,"running":0,"exited":0,"containers":[]}'; return 0
  fi
  local total running items="" name state status
  total=$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')
  running=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
  while IFS=$'\t' read -r name state status; do
    [ -z "$name" ] && continue
    items="${items}${items:+,}{\"name\":\"$(json_escape "$name")\",\"state\":\"$(json_escape "$state")\",\"status\":\"$(json_escape "$status")\"}"
  done < <(docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}' 2>/dev/null | head -n "$MONIT_DOCKER_MAX")
  printf '{"present":true,"total":%s,"running":%s,"exited":%s,"containers":[%s]}' \
    "$total" "$running" "$((total-running))" "$items"
}

collect_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    printf '{"present":false,"online":0,"stopped":0,"processes":[]}'; return 0
  fi
  local jlist out=""
  jlist=$(pm2 jlist 2>/dev/null || true)
  if [ -n "$jlist" ] && command -v jq >/dev/null 2>&1; then
    out=$(printf '%s' "$jlist" | jq -c '
      { present:true,
        online:  ([.[] | select(.pm2_env.status=="online")] | length),
        stopped: ([.[] | select(.pm2_env.status!="online")] | length),
        processes:[.[] | {name:.name, status:.pm2_env.status, pid:.pm2_env.pid}] }' 2>/dev/null) || out=""
  fi
  if [ -z "$out" ]; then
    local online stopped
    online=$(pm2 list 2>/dev/null | grep -c 'online' || true)
    stopped=$(pm2 list 2>/dev/null | grep -cE 'stopped|errored|stopping' || true)
    printf '{"present":true,"online":%s,"stopped":%s,"processes":[]}' "$online" "$stopped"
  else
    printf '%s' "$out"
  fi
}

collect_http() {
  local out="" url code lat
  [ -z "$MONIT_HTTP_CHECKS" ] && { printf '[]'; return 0; }
  local url_list=${MONIT_HTTP_CHECKS//,/ }
  for url in $url_list; do
    [ -z "$url" ] && continue
    local resp
    resp=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' \
        --max-time 3 --connect-timeout 2 "$url" 2>/dev/null) || resp="000 0"
    code=${resp%% *}
    lat=${resp##* }
    out="${out}${out:+,}{\"url\":\"$(json_escape "$url")\",\"status_code\":${code:-000},\"latency_ms\":$(awk -v t="${lat:-0}" 'BEGIN{printf "%.0f", t*1000}')}"
  done
  printf '[%s]' "$out"
}

# ---------------------------------------------------------------------------
# Assemble the full payload
# ---------------------------------------------------------------------------
build_payload() {
  local os
  os=$(uname -srmo 2>/dev/null | tr -s ' ')
  cat <<EOF
{
  "server_id":  "$(json_escape "$MONIT_SERVER_ID")",
  "timestamp":  "$(now_iso)",
  "hostname":   "$(json_escape "$(hostname 2>/dev/null || echo unknown)")",
  "os":         "$(json_escape "$os")",
  "uptime_s":   $(collect_uptime),
  "cpu":        $(collect_cpu),
  "ram":        $(collect_ram),
  "disk":       $(collect_disk),
  "network":    $(collect_net),
  "load":       $(collect_load),
  "gpu":        $(collect_gpu),
  "docker":     $(collect_docker),
  "pm2":        $(collect_pm2),
  "http":       $(collect_http)
}
EOF
}

# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------
curl_send() {
  local payload=$1
  [ -z "$MONIT_API_KEY" ] && return 1
  curl -sS -o /dev/null \
    --max-time "$MONIT_TIMEOUT" \
    --connect-timeout "$MONIT_CONNECT_TIMEOUT" \
    -H "Authorization: Bearer ${MONIT_API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    "$INGEST_URL" 2>/dev/null
}

buffer_payload() {
  local payload=$1 ts f count
  mkdir -p "$MONIT_BUFFER_DIR" 2>/dev/null || return 1
  ts=$(date +%Y%m%d%H%M%S%N)
  f="$MONIT_BUFFER_DIR/${ts}_${MONIT_SERVER_ID}.json"
  printf '%s' "$payload" > "$f" 2>/dev/null || return 1
  count=$(ls -1 "$MONIT_BUFFER_DIR"/*.json 2>/dev/null | wc -l)
  if [ "$count" -gt "$MONIT_BUFFER_MAX" ]; then
    ls -1tr "$MONIT_BUFFER_DIR"/*.json | head -n "$((count - MONIT_BUFFER_MAX))" | xargs -r rm -f
  fi
}

# Drain a bounded backlog — only called when a fresh send just SUCCEEDED
# (i.e., the central endpoint is reachable), so these calls are fast.
flush_buffer() {
  [ -d "$MONIT_BUFFER_DIR" ] || return 0
  local f n=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if curl_send "$(cat "$f" 2>/dev/null)"; then
      rm -f "$f"
    else
      break   # central went down mid-drain; stop to avoid wasting time
    fi
    n=$((n+1))
    [ "$n" -ge 10 ] && break   # cap per-run drain
  done < <(ls -1tr "$MONIT_BUFFER_DIR"/*.json 2>/dev/null | head -n 10)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
run_once() {
  local payload
  payload=$(build_payload)
  if curl_send "$payload"; then
    : # success
  else
    buffer_payload "$payload"
  fi
}

main() {
  local mode="${1:-}" interval="${2:-$MONIT_INTERVAL}"
  if [ "$mode" = "--loop" ]; then
    trap 'log "received signal, exiting"; exit 0' INT TERM
    log "starting loop mode, interval=${interval}s"
    while :; do
      run_once
      sleep "$interval"
    done
  else
    flush_buffer   # clear stale backlog (bounded) if central is up
    run_once
  fi
}

main "$@"
```

### 4.9 Agent Hardening & Deployment

- **Systemd unit (loop mode):**

```ini
# /etc/systemd/system/monit-agent.service
[Unit]
Description=monit-agent metrics shipper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/monit/agent.conf
ExecStart=/usr/bin/bash /opt/monit/monit-agent.sh --loop
Restart=always
RestartSec=15
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/monit-agent
# Resource caps (defense in depth)
MemoryMax=16M
CPUQuota=20%
LimitNOFILE=256

[Install]
WantedBy=multi-user.target
```

- **Cron (one-shot mode):** `* * * * * /opt/monit/monit-agent.sh >> /var/log/monit-agent.log 2>&1`
- **Privileges:** run as a dedicated non-root `monit` user; only read access to `/proc`, `/dev/nvidia*` (for GPU), and `docker` via group membership.
- **Rotation:** `logrotate` on `/var/log/monit-agent.log`; buffer dir cleaned by the agent itself (capped).

---

## 5. Application & Stack-Specific Monitoring

This section defines **how** the agent and platform verify the health of the actual workloads (not just the host).

### 5.1 Process / Service Health

| Target                | Check                                              | Signal reported                                   |
| --------------------- | -------------------------------------------------- | ------------------------------------------------- |
| **PM2**               | `pm2 jlist` → per-app `status`                     | `online`/`stopped`/`errored` + pid + memory       |
| **Docker**            | `docker ps -a` → per-container `State`             | `running`/`exited` + status string + counts       |
| **systemd services**  | `systemctl is-active <unit>` (optional extension)  | `active`/`failed`                                 |
| **Raw PID check**     | `kill -0 <pid>` or `/proc/<pid>` existence         | process alive / not                               |

- **Docker:** report running/exited counts and per-container state (capped at `MONIT_DOCKER_MAX`). A container that is `running` but restarting is still surfaced via the `status` string.
- **PM2:** with `jq`, report per-process name/status/pid/memory; without `jq`, fall back to online/stopped counts.
- **Alertable:** any expected PM2 app not `online`, or any expected container not `running`, can raise a `service_down` incident (see §6).

### 5.2 Database Metrics — Active Connections

**MySQL** (run as a DB user with appropriate privileges):

```bash
# Total connections
mysqladmin status 2>/dev/null | awk -F';' '{print $1}' | awk '{print $NF}'

# Active (non-sleeping) connections
mysql -N -e "SELECT COUNT(*) FROM information_schema.processlist
             WHERE COMMAND <> 'Sleep';" 2>/dev/null

# Max configured connections (context for threshold)
mysql -N -e "SHOW VARIABLES LIKE 'Max_connections';" 2>/dev/null | awk '{print $2}'
```

**PostgreSQL:**

```bash
# Total / active / idle
psql -tA -c "SELECT
    count(*) FILTER (WHERE state='active')  AS active,
    count(*) FILTER (WHERE state='idle')    AS idle,
    count(*)                                AS total
  FROM pg_stat_activity;" 2>/dev/null

# Max configured connections
psql -tA -c "SHOW max_connections;" 2>/dev/null
```

**Reported fields (added to payload under `databases`):**

```jsonc
"databases": {
  "mysql":   { "present": true, "total": 42,  "active": 17, "max": 151, "reachable": true },
  "postgres":{ "present": true, "total": 31,  "active": 9,  "max": 100, "reachable": true }
}
```

> These checks require local DB credentials. They should live in a root-only config and the agent should run them as a **read-only** DB user. `reachable:false` itself is alertable (DB down).

### 5.3 Web Server / Reverse-Proxy Health (HTTP 200)

The agent performs **local** HTTP checks against the apps it hosts, to confirm the process is actually serving (not just "alive").

- Configure `MONIT_HTTP_CHECKS` with the health endpoints, e.g.:
  - `http://127.0.0.1:3000/health` (Node/Express or Fastify)
  - `http://127.0.0.1:8080/healthz` (Next.js / a reverse-proxy target)
  - `http://127.0.0.1:8000/api/health` (Python / FastAPI)
  - `http://127.0.0.1:8888/api/status` (Jupyter server)
- Each check reports `status_code` and `latency_ms`. A `200` is healthy; anything else (or `000` = connection failure) is a failed check.
- These are the primary signal for "is my Node.js / Python app responding?" and map directly to a `http_unhealthy` alert rule.

### 5.4 Stack-Specific Notes

| Stack          | Notes                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **Angular / Vue (SSR) / Next.js** | Typically served by a Node process behind a reverse proxy; monitor the Node process + HTTP health. For Next.js, also watch `node` memory and, if exposed, `/_next/health`. |
| **Node.js (Express/Fastify)**     | Process liveness via PM2/Docker/systemd; HTTP health on the app port; memory (heap) is a common failure — surface `pm2.monit.memory` when `jq` is available. |
| **Python (FastAPI / Flask)**      | Same process + HTTP health pattern. For long-running jobs, consider a liveness file timestamp (app writes a heartbeat file the agent can check). |
| **Jupyter**                        | Health via `http://127.0.0.1:8888/api/status`; also watch for runaway kernels via per-process CPU/RAM. |
| **Multi-GPU**                      | `nvidia-smi` per-device utilization + VRAM. VRAM exhaustion is a common cause of job failure — alert on `mem_used_pct` and `util` spikes. |

---

## 6. Alerting & Notification System

### 6.1 Threshold Model

A **rule** is a declarative condition. Rules support:

- **Comparator** — `>`, `>=`, `<`, `<=`, `==`, `!=`.
- **Threshold** — a numeric value (or `null` for "not equals").
- **Duration / for** — the condition must persist for `N` minutes before the incident fires (debouncing flaps).
- **Recovery** — an optional recovery condition (defaults to the inverse of the trigger).
- **Severity** — `critical` | `warning` | `info`.
- **Scope** — applies to a project, a set of servers, or all.
- **Channels** — which notification channels to use for this rule.

**Rule examples (from the spec):**

| Rule                              | Expression                                  | For   | Severity |
| --------------------------------- | ------------------------------------------- | ----- | -------- |
| High RAM                          | `ram.used_pct > 90`                         | 3 min | critical |
| Low disk                          | `disk.avail_bytes < 5 * 1024 * 1024 * 1024` | 5 min | critical |
| CPU sustained                     | `cpu.total > 95`                            | 10 min| warning  |
| DB connections near limit         | `db.active_pct > 85`                        | 3 min | warning  |
| Service down (PM2/Docker)         | `expected_running == false`                 | 1 min | critical |
| HTTP unhealthy                    | `http.status_code != 200`                   | 2 min | critical |
| GPU VRAM pressure                 | `gpu.mem_used_pct > 95`                     | 5 min | warning  |
| Server offline                    | `no_sample > 3 * interval`                  | —     | critical |

### 6.2 Rule Evaluation & State Machine

The **Alert Engine** runs on each ingest (and on a 30 s safety tick). It maintains an in-memory/DB **state machine** per (rule, server):

```
        condition true for >= duration
  OK  ────────────────────────────────────────►  FIRING  (incident created, notify)
   ▲                                              │
   │   condition false (or recovery)             │  condition still true
   └─────────────────────────────────────────────┘
```

- **Debounce:** a condition must be true for the full `duration` before `FIRING` (prevents flapping on single-spike events).
- **Hysteresis:** an optional recovery threshold (e.g., trigger at >90%, recover at <85%) prevents rapid re-fire around the boundary.
- **Flapping guard:** if a rule fires/resolves more than `N` times in `M` minutes, it is auto-`flapping` (suppressed) and an operator is notified.
- **Silence / acknowledge:** incidents can be silenced for a period or acknowledged (stops re-notifying until a new fire).
- **Escalation:** optional second notification after `X` minutes if unacknowledged.

### 6.3 Notification Channels

| Channel         | Mechanism                                                            | Notes                                   |
| --------------- | -------------------------------------------------------------------- | --------------------------------------- |
| **Webhook**     | `POST` a JSON payload to a configured URL (generic)                  | Most flexible; can hit any system.       |
| **Slack**       | Incoming webhook / API → `chat.postMessage`                          | Supports rich blocks + @channel for crit.|
| **Line Notify** | `POST` to Line Notify API with `token`                               | For teams on LINE (APAC).               |

**Webhook / notification payload (common shape):**

```jsonc
{
  "event": "alert.fired",                 // fired | resolved | acknowledged | flapping
  "incident_id": "inc_20260817_000123",
  "rule_id": "rule_high_ram",
  "rule_name": "High RAM",
  "severity": "critical",
  "server_id": "web-prod-01",
  "server_name": "web-prod-01",
  "project": "Checkout Service",
  "environment": "Prod",
  "metric": "ram.used_pct",
  "value": 93.4,
  "threshold": 90,
  "duration_min": 3,
  "started_at": "2026-08-17T10:03:00Z",
  "message": "RAM on web-prod-01 above 90% for 3 min (93.4%)"
}
```

- **Retry & dead-letter:** failed deliveries retried with exponential backoff (max 5); after that, written to a `notification_dead_letter` table for manual replay.
- **Rate limiting / dedup:** repeated fires for the same incident are coalesced; a "still firing" reminder at most every `N` minutes.

### 6.4 Incident Logs

Every incident is persisted and viewable on the dashboard:

| Field              | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `id`               | Stable ID.                                              |
| `rule_id` / `rule_name` | Which rule fired.                                 |
| `server_id` / `project` / `environment` | Scope.                      |
| `severity`         | critical / warning / info.                              |
| `status`           | `firing` → `acknowledged` → `resolved` (or `flapping`/`silenced`). |
| `value` / `threshold` | The offending value and the rule threshold.         |
| `started_at` / `acknowledged_at` / `resolved_at` | Timeline.     |
| `duration`         | Computed time in firing state.                          |
| `notified`         | Which channels + timestamps.                            |
| `notes`            | Operator notes (ack/resolve).                           |

Retained long-term (see §8).

### 6.5 Rule Configuration Schema (stored in `alert_rules`)

| Column            | Type    | Description                                        |
| ----------------- | ------- | -------------------------------------------------- |
| `id`              | uuid    | PK                                                 |
| `name`            | text    | Human name                                         |
| `scope_type`      | enum    | `project` / `servers` / `all`                      |
| `scope_ids`       | uuid[]  | Project/server IDs (empty if `all`)                |
| `metric`          | text    | Metric path, e.g. `ram.used_pct`, `http.status_code` |
| `comparator`      | text    | `>`, `>=`, `<`, `<=`, `==`, `!=`                   |
| `threshold`       | float   | Numeric threshold (nullable)                       |
| `duration_min`    | int     | Minutes condition must hold                        |
| `recover_expr`    | text    | Optional recovery condition                        |
| `severity`        | enum    | `critical` / `warning` / `info`                    |
| `channels`        | jsonb   | `["slack","webhook:hook1","linenotify"]`           |
| `enabled`         | bool    |                                                  |
| `flap_limit`      | int     | Fires allowed in window before `flapping`          |
| `flap_window_min` | int     | Window for flap counting                           |
| `created_at` / `updated_at` | timestamptz | Audit.                                  |

---

## 7. API Design & Data Storage

### 7.1 Storage Choice

**Recommendation: TimescaleDB** (PostgreSQL extension) for metrics + **PostgreSQL** for metadata — a single, unified database.

| Option              | Time-series fit | Ops burden | Query flexibility | Verdict            |
| ------------------- | --------------- | ---------- | ----------------- | ------------------ |
| **TimescaleDB**     | Excellent (hypertables, continuous aggregates, compression, retention) | Low (it's Postgres) | Full SQL + JSONB | ✅ **Chosen**      |
| InfluxDB            | Excellent       | Medium (separate engine, Flux/InfluxQL) | Good, less SQL | Strong alt (if you want a dedicated TSDB) |
| Prometheus + Thanos | Excellent (scrape model) | High (extra cluster) | PromQL, not SQL | Mismatch — pull model, not our push design |
| Raw PostgreSQL      | Poor at high frequency (no native downsampling/compression) | Low | SQL | ❌ For 10 s samples across many servers |
| ClickHouse          | Excellent       | Medium (separate engine) | SQL-ish | Good for huge scale; overkill for v1 |

**Why TimescaleDB for this design:**
- The agent **pushes** at 10 s intervals — a relational ingestion path (INSERT) is natural (Prometheus is pull-based, so it's a poor fit).
- Hypertables + **continuous aggregates** handle 10 s → 1 min → 1 hour → 1 day rollups automatically.
- **Compression** + **retention policies** keep long-term storage cheap.
- Metadata (servers, projects, rules, incidents) lives in the **same engine** — one backup, one auth model, simple joins.

### 7.2 Data Model

**Time-series (hypertable) — raw samples, one row per sample:**

```sql
CREATE TABLE system_metrics (
  time       timestamptz NOT NULL DEFAULT now(),
  server_id  text        NOT NULL,
  cpu        jsonb,          -- {total, cores:[...]}
  ram        jsonb,
  load       jsonb,
  uptime_s   double precision,
  disk       jsonb,
  network    jsonb,          -- cumulative counters
  gpu        jsonb,
  docker     jsonb,
  pm2        jsonb,
  http       jsonb,
  databases  jsonb
);
SELECT create_hypertable('system_metrics', 'time',
  chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ON system_metrics (server_id, time DESC);
```

**Continuous aggregates (downsampling):**

```sql
-- 1-minute rollups (drives most dashboard queries)
CREATE MATERIALIZED VIEW metrics_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  server_id,
  avg((cpu->>'total')::float)        AS cpu_total_pct,
  avg((ram->>'used_pct')::float)     AS ram_used_pct,
  min((ram->>'free_kb')::bigint)     AS ram_free_kb,
  avg((load->>'1m')::float)          AS load_1m,
  max((load->>'cores')::int)         AS cores,
  -- network rate (bytes/s) from counters via rate()
  (rate(network->'0'->>'rx_bytes'))[1] AS net_rx_bps,
  (rate(network->'0'->>'tx_bytes'))[1] AS net_tx_bps
FROM system_metrics
GROUP BY bucket, server_id;
SELECT add_continuous_aggregate_policy('metrics_1m',
  start_offset => INTERVAL '15 minutes',
  end_offset   => INTERVAL '3 minutes',
  schedule_interval => INTERVAL '1 minute');

-- 1-hour and 1-day rollups for long-range views (similar pattern)
```

> **Counters → rates:** `network` and `uptime` are counters; the server computes per-second rates with Timescale's `rate()` (or by differencing consecutive samples) at query/aggregate time, mirroring the Prometheus counter model. Counter resets (reboot) are handled by `rate()`.

**Retention & compression:**

```sql
SELECT add_retention_policy('system_metrics',    INTERVAL '14 days');
SELECT add_retention_policy('metrics_1m',        INTERVAL '90 days');
SELECT add_retention_policy('metrics_1h',        INTERVAL '2 years');
-- Compress raw data after 7 days
ALTER TABLE system_metrics SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'server_id');
SELECT add_compression_policy('system_metrics', INTERVAL '7 days');
```

**Relational (metadata):**

```sql
CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('Prod','UAT','Dev') OR environment <> ALL(ARRAY['Prod','UAT','Dev'])),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE servers (
  id           text PRIMARY KEY,              -- == server_id (agent-provided)
  name         text NOT NULL,
  ip           inet,
  os           text,
  project_ids  uuid[] NOT NULL DEFAULT '{}',
  agent_key_hash text NOT NULL,               -- hashed bearer key
  last_seen    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE server_projects (           -- many-to-many
  server_id text REFERENCES servers(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, project_id)
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   text REFERENCES servers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_hash    text NOT NULL,
  scope       text NOT NULL DEFAULT 'ingest',
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_rules ( /* see §6.5 */ );

CREATE TABLE incidents (
  id            text PRIMARY KEY,
  rule_id       uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  server_id     text REFERENCES servers(id) ON DELETE CASCADE,
  severity      text NOT NULL,
  status        text NOT NULL DEFAULT 'firing',
  metric        text,
  value         double precision,
  threshold     double precision,
  started_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at   timestamptz,
  notes         text,
  notified      jsonb
);
CREATE INDEX ON incidents (server_id, started_at DESC);
CREATE INDEX ON incidents (status, started_at DESC);

CREATE TABLE notification_log (
  id          bigserial PRIMARY KEY,
  incident_id text REFERENCES incidents(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  success     boolean NOT NULL,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 7.3 REST API Design

Conventions: `Content-Type: application/json`, all times UTC, pagination via `?page=&limit=`, versioned under `/api/v1`. Errors use RFC 7807 (`application/problem+json`).

**Ingestion (machine-to-machine, Bearer agent key):**

| Method | Endpoint                | Auth          | Description                              |
| ------ | ----------------------- | ------------- | ---------------------------------------- |
| POST   | `/api/v1/ingest`        | agent Bearer  | Submit one sample (the agent payload).   |

**Server management:**

| Method | Endpoint                         | Auth        | Description                                   |
| ------ | -------------------------------- | ----------- | --------------------------------------------- |
| GET    | `/api/v1/servers`                | JWT (Viewer) | List servers; filters `?project=&env=&status=`. |
| POST   | `/api/v1/servers`                | JWT (Admin)  | Register a server + generate an API key.      |
| GET    | `/api/v1/servers/:id`            | JWT (Viewer) | Server detail + latest sample + health.      |
| PATCH  | `/api/v1/servers/:id`            | JWT (Admin)  | Update name/projects/ip.                     |
| DELETE | `/api/v1/servers/:id`            | JWT (Admin)  | Remove a server (soft-delete/archive).        |
| POST   | `/api/v1/servers/:id/keys/rotate`| JWT (Admin)  | Rotate the agent API key.                    |

**Projects:**

| Method | Endpoint                     | Auth        | Description                     |
| ------ | ---------------------------- | ----------- | ------------------------------- |
| GET    | `/api/v1/projects`           | JWT (Viewer)| List projects.                  |
| POST   | `/api/v1/projects`           | JWT (Admin) | Create project.                 |
| PUT    | `/api/v1/projects/:id`       | JWT (Admin) | Update project.                 |
| DELETE | `/api/v1/projects/:id`       | JWT (Admin) | Delete (archive) project.       |

**Metrics (dashboard):**

| Method | Endpoint                                            | Auth        | Description                                   |
| ------ | --------------------------------------------------- | ----------- | --------------------------------------------- |
| GET    | `/api/v1/servers/:id/summary`                       | JWT (Viewer)| Latest values + health + top offenders.       |
| GET    | `/api/v1/servers/:id/metrics`                       | JWT (Viewer)| Query series. Params: `metric`, `from`, `to`, `agg=avg|max|min`, `bucket=1m`. |
| GET    | `/api/v1/projects/:id/overview`                     | JWT (Viewer)| Project-level rollup (counts, avg CPU/RAM).   |
| GET    | `/api/v1/fleet/health`                              | JWT (Viewer)| Fleet-wide KPIs for the landing page.         |

**Alerting:**

| Method | Endpoint                          | Auth        | Description                          |
| ------ | --------------------------------- | ----------- | ------------------------------------ |
| GET    | `/api/v1/alerts`                  | JWT (Viewer)| Active incidents; `?severity=&project=`. |
| POST   | `/api/v1/alerts/:id/ack`          | JWT (Operator)| Acknowledge an incident.           |
| POST   | `/api/v1/alerts/:id/resolve`      | JWT (Operator)| Resolve an incident.             |
| POST   | `/api/v1/alerts/:id/silence`      | JWT (Operator)| Silence for a duration.            |
| GET    | `/api/v1/incidents`               | JWT (Viewer)| Incident history; filterable.      |
| GET    | `/api/v1/alert-rules`             | JWT (Viewer)| List rules.                        |
| POST   | `/api/v1/alert-rules`             | JWT (Admin) | Create rule.                       |
| PUT    | `/api/v1/alert-rules/:id`         | JWT (Admin) | Update rule.                       |
| DELETE | `/api/v1/alert-rules/:id`         | JWT (Admin) | Delete rule.                       |
| POST   | `/api/v1/webhooks/test`           | JWT (Admin) | Test a notification channel.        |

**System:**

| Method | Endpoint        | Auth | Description              |
| ------ | --------------- | ---- | ------------------------ |
| GET    | `/api/v1/health`| none | Liveness/readiness probe.|

### 7.4 API Examples

**Ingest (agent → server):**

```bash
curl -X POST https://monitor.example.com/api/v1/ingest \
  -H "Authorization: Bearer sk_agent_9f8e7d6c5b4a" \
  -H "Content-Type: application/json" \
  -d '{
    "server_id":"web-prod-01",
    "timestamp":"2026-08-17T10:00:00Z",
    "uptime_s":1234567,
    "cpu":{"total":42.5,"cores":[{"id":"0","used":30.1},{"id":"1","used":55.2}]},
    "ram":{"total_kb":16777216,"used_kb":8388608,"free_kb":2097152,"used_pct":50.0},
    "disk":[{"mount":"/","device":"/dev/sda1","size_kb":104857600,"used_kb":52428800,"avail_kb":52428800,"used_pct":50.0}],
    "network":[{"iface":"eth0","rx_bytes":987654321,"tx_bytes":123456789}],
    "load":{"1m":2.15,"5m":1.80,"15m":1.40,"cores":8},
    "gpu":[],
    "docker":{"present":true,"total":6,"running":5,"exited":1},
    "pm2":{"present":true,"online":4,"stopped":1},
    "http":[{"url":"http://127.0.0.1:3000/health","status_code":200,"latency_ms":12}]
  }'
# → 202 Accepted
```

**Query metric series (dashboard → server):**

```bash
curl -G https://monitor.example.com/api/v1/servers/web-prod-01/metrics \
  -H "Authorization: Bearer <JWT>" \
  --data-urlencode "metric=cpu.total" \
  --data-urlencode "from=2026-08-17T00:00:00Z" \
  --data-urlencode "to=2026-08-17T10:00:00Z" \
  --data-urlencode "agg=avg" \
  --data-urlencode "bucket=1m"
```

```jsonc
{
  "server_id": "web-prod-01",
  "metric": "cpu.total",
  "unit": "percent",
  "bucket": "1m",
  "points": [
    { "t": "2026-08-17T09:58:00Z", "v": 41.2 },
    { "t": "2026-08-17T09:59:00Z", "v": 43.8 },
    { "t": "2026-08-17T10:00:00Z", "v": 42.5 }
  ]
}
```

### 7.5 Security & Rate Limiting

- **TLS termination** at the reverse proxy (Caddy/Nginx); HTTP redirects to HTTPS.
- **Ingestion auth:** per-server Bearer key, hashed at rest, scope-limited to `ingest`. The server validates that the payload's `server_id` matches the key's owner.
- **Rate limiting:** per-server ingest rate capped (e.g., max 6 req/s) to guard against a misconfigured agent flooding the API; excess returns `429`.
- **Query auth:** JWT with role-based access; dashboard queries are authorized to the caller's allowed projects (row-level for multi-tenant setups).
- **Input validation:** payload size limit (e.g., 256 KB), schema validation (Ajv), numeric bounds.
- **Secrets:** agent keys, DB creds, webhook/Slack/Line tokens stored in a secrets manager / environment, **never** in code or logs.
- **Audit:** admin mutations (rules, keys, projects) are audit-logged.

---

## 8. Non-Functional Requirements

| Category       | Requirement                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| **Performance** | Ingest 10 s samples from 100 servers with < 100 ms p95 write latency.          |
| **Scalability** | Linear horizontal scaling of ingestion + query; single DB up to ~1000 servers. |
| **Availability** | Central tier 99.9%; agents must tolerate central outage (buffered).            |
| **Retention**   | Raw 14 d, 1-min 90 d, 1-hour 2 y (configurable).                               |
| **Freshness**   | Dashboard reflects data within ~10–30 s of a sample.                           |
| **Security**    | TLS everywhere, hashed secrets, RBAC, per-server keys, rate limits.            |
| **Observability** | The monitor monitors itself: ingest lag, DB size, alert-worker health.      |
| **Portability** | Agent runs on any Linux with coreutils; no compiled deps.                     |
| **Cost**        | Single PostgreSQL engine; compression keeps long-term storage low.            |

---

## 9. Implementation Roadmap

| Phase | Scope                                                              | Deliverable                                  |
| ----- | ------------------------------------------------------------------ | -------------------------------------------- |
| **0** | Repo, CI, infra (Postgres+Timescale, Docker Compose), API skeleton | Runnable skeleton + schema migrations        |
| **1** | Agent v1 (system metrics) + Ingestion + storage                    | Agents shipping data to TimescaleDB          |
| **2** | Query API + Dashboard: fleet view, server detail, core charts      | MVP dashboard (CPU/RAM/Disk/Net)             |
| **3** | Extended metrics (GPU/load/uptime) + app health (Docker/PM2/HTTP)  | Full metric coverage                         |
| **4** | DB metrics + Alert engine + Notifications (Webhook/Slack/Line)     | Alerting end-to-end                          |
| **5** | Projects/groups, RBAC, incident management, rule builder           | Multi-project, self-service                  |
| **6** | HA, retention/compression tuning, self-monitoring, docs            | Production-hardened                          |

---

## 10. Appendices

### Appendix A — Sample Agent Config (`/etc/monit/agent.conf`)

```bash
# /etc/monit/agent.conf  (root:monit, 0640)
MONIT_API_URL=https://monitor.example.com
MONIT_SERVER_ID=web-prod-01
MONIT_API_KEY=sk_agent_9f8e7d6c5b4a
MONIT_INTERVAL=10
MONIT_TIMEOUT=5
MONIT_CONNECT_TIMEOUT=2
MONIT_BUFFER_DIR=/var/lib/monit-agent/buffer
MONIT_BUFFER_MAX=50
MONIT_NET_IFACES="eth0"
MONIT_GPU=auto
MONIT_HTTP_CHECKS="http://127.0.0.1:3000/health,http://127.0.0.1:8000/api/health"
MONIT_DOCKER_MAX=100
```

### Appendix B — Sample Alert Rules (seed)

```jsonc
[
  { "name":"High RAM",        "metric":"ram.used_pct",   "comparator":">",  "threshold":90, "duration_min":3,  "severity":"critical", "channels":["slack","webhook:ops"] },
  { "name":"Low Disk",        "metric":"disk.avail_bytes","comparator":"<",  "threshold":5368709120, "duration_min":5, "severity":"critical", "channels":["slack"] },
  { "name":"CPU Sustained",   "metric":"cpu.total",      "comparator":">",  "threshold":95, "duration_min":10, "severity":"warning",  "channels":["slack"] },
  { "name":"Server Offline",  "metric":"no_sample",      "comparator":">",  "threshold":30, "duration_min":0,  "severity":"critical", "channels":["slack","linenotify"] },
  { "name":"HTTP Unhealthy",  "metric":"http.status_code","comparator":"!=","threshold":200,"duration_min":2,  "severity":"critical", "channels":["slack"] },
  { "name":"GPU VRAM Pressure","metric":"gpu.mem_used_pct","comparator":">", "threshold":95, "duration_min":5,  "severity":"warning",  "channels":["webhook:ops"] }
]
```

### Appendix C — Metric Dictionary

| Metric path          | Kind    | Unit     | Source            | Alertable |
| -------------------- | ------- | -------- | ----------------- | --------- |
| `cpu.total`          | gauge   | %        | `/proc/stat`      | yes       |
| `cpu.cores[].used`   | gauge   | %        | `/proc/stat`      | optional  |
| `ram.used_pct`       | gauge   | %        | `/proc/meminfo`   | yes       |
| `ram.free_kb`        | gauge   | KB       | `/proc/meminfo`   | optional  |
| `disk.avail_bytes`   | gauge   | bytes    | `df`              | yes       |
| `disk.used_pct`      | gauge   | %        | `df`              | optional  |
| `net.rx_bps`         | rate    | bytes/s  | `/proc/net/dev`   | optional  |
| `net.tx_bps`         | rate    | bytes/s  | `/proc/net/dev`   | optional  |
| `load.1m/5m/15m`     | gauge   | —        | `/proc/loadavg`   | yes       |
| `uptime_s`           | counter | seconds  | `/proc/uptime`    | no        |
| `gpu.util_pct`       | gauge   | %        | `nvidia-smi`      | optional  |
| `gpu.mem_used_pct`   | gauge   | %        | `nvidia-smi`      | yes       |
| `docker.running`     | gauge   | count    | `docker ps`       | yes       |
| `pm2.online`         | gauge   | count    | `pm2 jlist`       | yes       |
| `http.status_code`   | gauge   | code     | `curl`            | yes       |
| `http.latency_ms`    | gauge   | ms       | `curl`            | optional  |
| `db.active`          | gauge   | count    | `mysql`/`psql`    | yes       |
| `no_sample`          | gauge   | seconds  | ingestion         | yes       |

### Appendix D — Environment Variable Reference (Agent)

See **§4.3** for the full list. Key variables: `MONIT_API_URL`, `MONIT_SERVER_ID`, `MONIT_API_KEY`, `MONIT_INTERVAL`, `MONIT_TIMEOUT`, `MONIT_BUFFER_DIR`, `MONIT_BUFFER_MAX`, `MONIT_NET_IFACES`, `MONIT_GPU`, `MONIT_HTTP_CHECKS`.

---

*End of document.*
