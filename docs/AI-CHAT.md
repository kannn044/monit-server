# AI chat & reports

The chat page answers questions about the fleet, and can produce stored HTML
reports. It runs entirely against a local OpenAI-compatible endpoint (vLLM) —
nothing leaves the network.

---

## How a question is answered

    question
      │
      ├─ route      keyword classification → intent + which servers are named
      │             (lookup / analyze / capacity / topology / report)
      │
      ├─ context    fleetSnapshot(): one round of SQL that computes, per server,
      │             current values, 24h/7d percentiles, 7-day regr_slope trends,
      │             disk-full projection, a z-score against the same hour on the
      │             past 7 days, expected-vs-actual services, and NDB topology
      │
      ├─ gather     the model calls read-only tools for anything the context
      │             does not already hold (skipped for a simple lookup)
      │
      └─ answer     one streaming turn with everything gathered

The rule the whole design follows: **SQL produces every number, the model
produces the explanation.** A local 8B-class model asked to compute a p95 or a
trend from raw samples gets it wrong often, and confidently. It is very good at
interpreting a number it was handed.

`server/src/lib/`

| File | Does |
|---|---|
| `ai-analytics.js` | the SQL, and the compact text the model reads |
| `ai-prompt.js` | system prompt, domain rules, analysis protocol, routing |
| `ai-tools.js` | the ten read-only tools and their schemas |
| `ai-llm.js` | vLLM client, sampling profiles, capability degradation |
| `ai-report.js` | report datasets, JSON-schema narration, HTML + SVG rendering |

## Tools the model can call

`list_servers` · `get_server_detail` · `query_metrics` · `get_incidents` ·
`get_incident_history` · `get_ndb_topology` · `get_services` ·
`get_alert_rules` · `get_notification_stats` · `correlate` — all read-only, all
available to any signed-in role.

`run_sql` is off by default. It accepts one `SELECT`, rejects every writing or
system keyword, forces a `LIMIT`, runs inside `BEGIN READ ONLY` with a
statement timeout, and requires the `admin` role. Turn it on with
`AI_ALLOW_SQL=1` — and if you do, give the app a database role that can only
read (see the bottom of this file).

## Reports

`fleet_health` · `critical` · `capacity` · `ndb_topology`

Generated from the same snapshot, narrated through a JSON schema (so the model
fills fields rather than writing markup), then rendered server-side into
self-contained HTML with inline SVG. Charts are drawn from the dataset, so a
chart cannot disagree with the database whatever the model says. Reports are
stored in `ai_reports` with their dataset and narrative, and are never
re-rendered — a report is a record of a moment.

The NDB diagram lays nodes out **by node group**, because that is the thing that
decides survival: a group down to one live node is one failure from taking the
whole cluster offline, and an id-ordered list hides exactly that.

## Measuring whether a change helped

```bash
MONIT_URL=http://localhost:8080 MONIT_EMAIL=admin@example.com \
MONIT_PASSWORD='…' node server/test/ai-eval/run.js
```

Each question in `server/test/ai-eval/questions.json` carries a SQL expression
that produces the right answer, so the model is graded against the database
rather than against an impression. Run it before and after any prompt change.
Add `--json` for CI.

Every chat turn is also recorded in `ai_chat_log` (question, intent, tools
called, latency, and the thumbs from the UI).

---

## What to change on the vLLM side

Nothing is required — the app probes the endpoint and quietly degrades. But
three server flags decide how good the answers get.

### 1. Point the app at the right endpoint

In `.env` on the monit host:

```ini
VLLM_BASE_URL=http://<vllm-host>:8084/v1
```

Leave `VLLM_MODEL` blank. When vLLM is started with `vllm serve /model`, the
served model id is literally `/model`, and the app reads it from `/v1/models`
rather than guessing.

Check it from inside the container, which is where it has to work:

```bash
docker compose -f docker-compose.app-only.yml exec app \
  sh -c 'wget -qO- "$VLLM_BASE_URL/models"'
```

### 2. Enable tool calling — the one that matters most

Without it the model can only answer from what was packed into the prompt.
With it, it can go and look: pull 7 days of a metric, search past incidents for
the same signature, read the cluster topology.

Add to the vLLM command line:

```
--enable-auto-tool-choice --tool-call-parser hermes
```

`hermes` is the parser for Qwen3. Restart is required — the flag is read at
startup. Verify:

```bash
curl -s http://localhost:8084/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{
  "model":"/model",
  "messages":[{"role":"user","content":"which servers are down?"}],
  "tools":[{"type":"function","function":{
    "name":"list_servers",
    "description":"list servers",
    "parameters":{"type":"object","properties":{"health":{"type":"string"}}}}}],
  "tool_choice":"auto","max_tokens":80}' | head -c 600
```

A `tool_calls` array in the reply means it works. An HTTP 400 mentioning tools
means the flag is missing — the app will detect that on its first request and
fall back to constrained-JSON tool selection, which is slower and does one
round instead of two.

The dashboard shows `tools on` / `tools off` next to the model name, so you can
see which mode you are in without reading logs. `GET /api/v1/chat/capabilities`
returns the same thing in full.

### 3. Prefix caching

```
--enable-prefix-caching
```

The system prompt is now long and mostly identical between messages (fleet
state changes slowly). Prefix caching keeps its KV cache between requests, so
time-to-first-token drops sharply. This is what pays for the richer context.

### 4. Context length

The context is bigger than before: the fleet block, tool results, and for a
report a few thousand tokens of figures. Give it room:

```
--max-model-len 32768
```

If the GPU cannot hold that with the current `--gpu-memory-utilization`, lower
the utilisation target first, then the context — a truncated prompt fails as a
confusingly incomplete answer rather than an error.

### 5. Thinking mode

The old prompt ended with `Use /no_think to disable thinking mode.`, which
pinned Qwen3's reasoning **off** for every question. That is now controlled per
request instead: off for lookups, on for analysis, through
`chat_template_kwargs: {enable_thinking: true}`.

This needs the Qwen3 chat template that understands the flag — it ships with
the model. If your `/model` directory has a custom template that does not, vLLM
returns 400 and the app disables the field for the rest of the process, which
is fine: you lose the per-question switch, not the feature. Set
`AI_THINKING=0` to stop sending it at all.

### Putting it together

```bash
docker inspect vllm_qwen38_mtp_a30 --format '{{json .Args}}' | python3 -m json.tool
```

Take the arguments that are already there — model path, MTP / speculative
decoding, tensor parallel, gpu memory utilisation — and add:

```
--enable-auto-tool-choice \
--tool-call-parser hermes \
--enable-prefix-caching \
--max-model-len 32768
```

then recreate the container. Nothing else about the deployment changes.

> If your build is older than the `--enable-auto-tool-choice` flag, or the
> parser name differs, leave it out. The app works either way; it just spends
> one constrained-JSON call deciding what to look up instead of using the
> native path.

---

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `VLLM_BASE_URL` | `http://host.docker.internal:8000/v1` | OpenAI-compatible endpoint |
| `VLLM_MODEL` | *(blank)* | pin a model id; blank asks `/v1/models` |
| `CHAT_MAX_HISTORY` | `20` | past messages forwarded |
| `AI_THINKING` | `1` | send `enable_thinking` per request |
| `AI_MAX_TOOL_ROUNDS` | `2` | tool-gathering rounds before answering; `0` disables tools |
| `AI_ALLOW_SQL` | *(off)* | expose `run_sql` to admins |
| `AI_SQL_TIMEOUT_MS` | `5000` | statement timeout for `run_sql` |
| `AI_REQUEST_TIMEOUT_MS` | `180000` | give up on a model call |

## A read-only database role for `run_sql`

Nothing written in JavaScript should be the only thing standing between a
prompt injection and your data. If you enable `AI_ALLOW_SQL`, give the database
the last word:

```sql
CREATE ROLE monit_ai LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE monit_server TO monit_ai;
GRANT USAGE ON SCHEMA public TO monit_ai;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO monit_ai;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO monit_ai;
```

Running the app itself as that role is not possible — it has to write metrics —
so this is a second connection if you want the strongest form. The in-process
guard (single statement, `SELECT` only, keyword deny-list, forced `LIMIT`,
`BEGIN READ ONLY`, statement timeout) is what protects the default setup.
