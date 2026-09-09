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

Generation is **asynchronous**: `POST /api/v1/reports` returns `202` with a row
in `status: 'pending'`, the work continues server-side, and the page polls
`GET /api/v1/reports/:id`. A model call on a local GPU runs for a minute or
more; held open as a request it gave the page nothing to show but a disabled
button, and anything slower than nginx's `proxy_read_timeout` came back as a
504 even though the server went on to finish and store the report. A row that
fails keeps its reason in `error` rather than disappearing.

Reports are generated from the same snapshot, narrated through a JSON schema (so
the model fills fields rather than writing markup), then rendered server-side
into self-contained HTML with inline SVG. Charts are drawn from the dataset, so a
chart cannot disagree with the database whatever the model says. Reports are
stored in `ai_reports` with their dataset and narrative, and are never
re-rendered — a report is a record of a moment.

The NDB diagram lays nodes out **by node group**, because that is the thing that
decides survival: a group down to one live node is one failure from taking the
whole cluster offline, and an id-ordered list hides exactly that.

## When the chat request hangs

A `POST /api/v1/chat` that sits pending and then returns **504** with an idle
GPU means the request never reached the model. Ask the endpoint, do not guess:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://your-host/monit/api/v1/chat/diag | python3 -m json.tool
```

It times every snapshot query separately and then probes vLLM:

```json
{"total_db_ms": 87,
 "steps": [{"step":"servers","ms":3,"rows":8},
           {"step":"latest_sample","ms":3,"rows":8},
           {"step":"stats_24h","ms":21,"rows":8},
           {"step":"week_trend_baseline","ms":19,"rows":8}, …],
 "vllm": {"ok": true, "ms": 12, "models": ["qwen3.8-27b"]}}
```

- **`total_db_ms` in the thousands** — the database is the problem. Almost
  always this means TimescaleDB is not enabled, so `metrics_1h` is a plain view
  aggregating the whole table. The queries here no longer read it (they sample
  raw rows through the `(server_id, time DESC)` index instead), but the
  dashboard's own charts still do. `docker compose logs app | grep migrate`
  says which path the migration runner chose.
- **`vllm.ok: false`** — the endpoint is unreachable from inside the container.
  `VLLM_BASE_URL` pointing at `127.0.0.1` is the usual cause: a container's
  loopback is its own.
- **both fine, still slow** — it is the model. Watch `nvtop` while asking.

### nginx

The chat reply is a Server-Sent Events stream, and it must not be buffered:

```nginx
proxy_read_timeout 120s;
proxy_buffering off;
proxy_cache off;
```

`docs/NGINX.md` has the full block. A 504 at almost exactly 60 seconds is
nginx's default `proxy_read_timeout` — the deployed config is missing these
lines even if the documented one has them. Without `proxy_buffering off` the
symptom is different and easy to misread: the answer works, but arrives in one
lump at the end instead of streaming, so the page looks frozen. The app also
sends `X-Accel-Buffering: no` on that response, which covers the case where
nobody edited the site config.

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

**Very little.** A vLLM started like the reference deployment below already has
everything this feature wants:

```
vllm serve /model
  --served-model-name qwen3.8-27b
  --quantization compressed-tensors --tensor-parallel-size 2 --dtype bfloat16
  --max-model-len 196608 --kv-cache-dtype fp8
  --enable-prefix-caching --enable-chunked-prefill
  --max-num-batched-tokens 2048 --max-num-seqs 16
  --gpu-memory-utilization 0.85
  --reasoning-parser deepseek_r1
  --enable-auto-tool-choice --tool-call-parser qwen3_xml
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```

| Flag | Why it matters here |
|---|---|
| `--enable-auto-tool-choice` + `--tool-call-parser qwen3_xml` | the model can go and look things up instead of answering only from the prompt |
| `--enable-prefix-caching` | the system prompt is long and nearly identical between messages; this is what keeps time-to-first-token down |
| `--reasoning-parser deepseek_r1` | **the one flag to change** — see below; `qwen3` is the right parser for this model |
| `--max-model-len 196608` | far more than the ~2k-token context pack or a report needs |

### The one thing to configure

`.env` on the monit host:

```ini
VLLM_BASE_URL=http://<vllm-host>:8084/v1
```

Leave `VLLM_MODEL` blank. The app reads the id from `/v1/models` — with
`--served-model-name qwen3.8-27b` that is `qwen3.8-27b`, not the `/model` path,
and pinning the wrong one 404s every message while the model list still loads
fine. Check it from inside the container, which is where it has to work:

```bash
docker compose -f docker-compose.app-only.yml exec app \
  sh -c 'wget -qO- "$VLLM_BASE_URL/models"'
```

### The one flag worth changing: `--reasoning-parser`

`--reasoning-parser deepseek_r1` is the wrong parser for Qwen3, and it fails in
a way that looks like tool calling being broken.

The DeepSeek-R1 parser assumes a reply *opens* in reasoning mode and splits it
at the first `</think>`. Qwen3 with `enable_thinking: false` never emits that
tag, so there is no split point and the parser files the entire reply under
`reasoning` — including a perfectly formed tool call:

```json
{"message":{"content":null,"tool_calls":[],
  "reasoning":"<tool_call>\n<function=list_servers>\n<parameter=health>\ndown\n</parameter>\n</function>\n</tool_call>"},
 "finish_reason":"stop"}
```

The model did exactly the right thing. `content: null`, `tool_calls: []` and
`finish_reason: "stop"` say it did nothing at all.

**Fix:**

```
--reasoning-parser qwen3        # instead of deepseek_r1
```

That parser knows a Qwen3 reply may carry no think block, so `content` stays
`content` and the `qwen3_xml` tool parser gets text to work on. It is the only
server-side change worth making, and it needs a container restart.

**Until then, the app copes on its own.** `ai-llm.js` recognises the signature —
stopped normally, said nothing, "thought" something substantial — and:

- reads the reply out of `reasoning`;
- recovers `<tool_call>` blocks from it with its own XML parser
  (`parseXmlToolCalls`, which also accepts the JSON shape);
- records `caps.noThinkSafe = false` and keeps thinking **on** for every
  subsequent turn, since the cheap no-think mode is what triggers the problem.

The cost of leaving it unfixed is latency and tokens: every lookup reasons
before answering, where it could have replied immediately. Nothing breaks.

The same salvage runs on the streaming path — a reply that arrives entirely as
`reasoning` deltas is shown as the answer rather than as an empty bubble.

Field naming, separately: reasoning arrives as `reasoning_content` in streaming
deltas and `reasoning` on a non-streaming reply, depending on the release. Both
are read.

### Watch `max_tokens` too

Reasoning tokens count against `max_tokens`. A turn with a small budget can
spend all of it thinking and return `content: null` with
`finish_reason: "length"` — a different failure with the same empty look. The
tool-selection turn is therefore given 1400 tokens rather than the ~100 it
emits, and a planning turn that stops on `length` without deciding anything
falls through to answering from the context pack instead of retrying into the
same wall.

### Verifying

```bash
curl -s http://localhost:8084/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{
  "model":"qwen3.8-27b","max_tokens":600,"tool_choice":"auto",
  "chat_template_kwargs":{"enable_thinking":false},
  "messages":[{"role":"user","content":"which servers are down?"}],
  "tools":[{"type":"function","function":{
    "name":"list_servers","description":"list servers",
    "parameters":{"type":"object","properties":{"health":{"type":"string"}}}}}]}'
```

Three outcomes:

| Reply | Meaning |
|---|---|
| `tool_calls` has an entry | the whole path works |
| `tool_calls: []`, `reasoning` contains `<tool_call>`, `finish_reason: "stop"` | the reasoning parser swallowed it — switch to `--reasoning-parser qwen3` |
| `tool_calls: []`, `reasoning` is prose, `finish_reason: "length"` | the budget ran out mid-thought — raise `max_tokens` |

An HTTP 400 naming a field means this build does not take it; the app detects
that on its first request and drops the field for the rest of the process.

The dashboard shows `tools on` / `tools off` beside the model name, and
`GET /api/v1/chat/capabilities` reports what was actually accepted.

### If you are running an older vLLM

Without `--enable-auto-tool-choice` the app falls back to picking tools through
constrained JSON: slower, one round instead of two, and everything else works.
Nothing needs to be configured for that fallback — it turns itself on.

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
| `AI_LANG` | `th` | answer language: `th`, `en`, or `auto` to follow the question |
| `AI_ANALYTICS_TIMEOUT_MS` | `4000` | ceiling on one optional analytics query |
| `AI_ANALYTICS_TTL_MS` | `120000` | how long percentiles and trends are reused |
| `AI_SNAPSHOT_TTL_MS` | `15000` | how long one fleet snapshot is reused |

### Why the language is a setting

`AI_LANG` defaults to `th`, and the reason is worth stating: everything around
the question — the domain notes, the analysis protocol, the metric names, every
tool result — is English. A model reading three thousand English tokens answers
in English however the question was phrased, and "reply in the language the user
wrote in" is not strong enough to overcome that. The language is therefore
decided server-side and stated as an instruction twice: once near the top where
it frames the task, and once as the very last line of the prompt, because the
end is what a model weighs most. `AI_LANG=auto` restores the old behaviour.

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
