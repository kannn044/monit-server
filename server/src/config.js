import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read .env, if there is one.
 *
 * Until now nothing in the Node process did. `.env` was read by docker compose,
 * which turns it into real environment variables before the container starts,
 * and by the shell scripts with grep — so editing DATABASE_URL there and running
 * `npm run dev` changed nothing at all, and the app quietly used the built-in
 * default. That is a bad way to find out, so load the file here.
 *
 * Real environment variables still win: `DATABASE_URL=… npm run dev` overrides
 * the file, which is the behaviour everyone expects from a .env.
 *
 * Deliberately not the `dotenv` package — this is thirty lines and the server
 * has no other runtime dependency it does not need.
 */
function loadEnvFile() {
  const candidates = [
    process.env.MONIT_ENV_FILE,                    // explicit wins
    path.join(__dirname, '../.env'),               // server/.env
    path.join(__dirname, '../../.env'),            // the repo root, next to docker-compose.yml
  ].filter(Boolean);

  const file = candidates.find((p) => existsSync(p));
  if (!file) return null;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    // Unreadable is worth saying out loud: on a shared checkout .env is often
    // root-only, and silently falling back to defaults is how you end up
    // connecting to the wrong database.
    console.warn(`[config] ${file} exists but could not be read: ${e.message}`);
    return null;
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key in process.env) continue;             // the real environment wins
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return file;
}

export const envFile = loadEnvFile();

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || 'postgres://monit:monit_dev_password@127.0.0.1:5432/monit',
  // Both blank by default: the app generates a signing secret (persisted in
  // app_settings) and a first-run admin password, so no configuration is
  // required to stand up a working, non-default-credential install.
  jwtSecret: process.env.JWT_SECRET || '',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Point a development copy at a production database without it acting like a
  // second production instance.
  //
  // Three things happen at startup that are fine for the one real deployment and
  // wrong for anything else sharing its database: migrations run (altering a
  // live schema the moment someone with a newer checkout presses start), the
  // alert engine begins evaluating the same rules a second time, and pg-boss
  // starts a second notifier — so every alert is delivered twice.
  //
  // MONIT_READONLY=1 turns off all three. The API and dashboard still work, and
  // ingest still writes, so it is not read-only at the SQL level; it means "this
  // process is not the one running the show".
  readOnly: /^(1|true|yes)$/i.test(process.env.MONIT_READONLY || ''),
  sampleIntervalS: Number(process.env.SAMPLE_INTERVAL_S || 10),
  alertTickS: Number(process.env.ALERT_TICK_S || 30),
  ingestMaxBodyBytes: 256 * 1024,
  // per-server ingest rate limit: max requests per window.
  // Raise INGEST_RATE_MAX temporarily when backfilling historical samples.
  ingestRateLimit: {
    max: Number(process.env.INGEST_RATE_MAX || 12),
    windowMs: Number(process.env.INGEST_RATE_WINDOW_MS || 10_000),
  },
  accessTokenTtl: '15m',
  refreshTokenTtl: '7d',
  // "offline" = no sample for offlineFactor × interval
  offlineFactor: 3,

  // ---- AI chat (local vLLM, OpenAI-compatible) ---------------------------
  //
  // The base URL has to be reachable *from wherever this process runs*, which
  // in Docker is not the host's loopback: a container's 127.0.0.1 is its own.
  // Either point this at the host's LAN address, or keep the default and give
  // the compose service
  //     extra_hosts: ["host.docker.internal:host-gateway"]
  // which is what docker-compose*.yml here already does.
  //
  // Trailing slashes are stripped because every call appends its own path
  // ("/models", "/chat/completions") and "…/v1//models" is a 404 on vLLM.
  vllmBaseUrl: (process.env.VLLM_BASE_URL || 'http://host.docker.internal:8000/v1').replace(/\/+$/, ''),
  // Blank = ask /v1/models on each request and use the first one served. Pin it
  // once you serve more than one model, otherwise the answer depends on order.
  vllmModel: process.env.VLLM_MODEL || '',
  // How many past messages to forward. The system prompt already carries the
  // whole fleet, so an unbounded transcript is what overflows a local model's
  // context window — and it fails as a confusing truncated reply, not an error.
  chatMaxHistory: Number(process.env.CHAT_MAX_HISTORY || 20),

  // Qwen3 is a hybrid reasoning model and the old prompt pinned its reasoning
  // off for every question. It is now chosen per request instead — but only if
  // the served chat template understands the flag, which ai-llm.js probes once.
  aiThinking: !/^(0|false|no)$/i.test(process.env.AI_THINKING || '1'),
  // Rounds of tool calling before the model has to answer. Two is enough to
  // look something up and then follow it; more mostly buys latency. 0 turns
  // tool use off entirely and falls back to answering from the context pack.
  aiMaxToolRounds: Number(process.env.AI_MAX_TOOL_ROUNDS || 2),
  // Letting the model write its own SELECT answers questions nobody predicted,
  // and is the largest attack surface in the feature. Off unless asked for, and
  // admin-only even then. See docs/AI-CHAT.md for the database role to pair it
  // with — the in-process guard should not be the only thing standing there.
  aiAllowSql: /^(1|true|yes)$/i.test(process.env.AI_ALLOW_SQL || ''),
  aiSqlTimeoutMs: Number(process.env.AI_SQL_TIMEOUT_MS || 5000),
  // Ceiling on each optional analytics query (percentiles, trends, baselines).
  // Past this the query is abandoned and the answer goes out without trends —
  // a degraded answer beats a request that hangs until nginx returns 504.
  aiAnalyticsTimeoutMs: Number(process.env.AI_ANALYTICS_TIMEOUT_MS || 4000),
  // Percentiles over 24h and trends over a week do not move between two
  // messages typed a minute apart, so they are computed once and reused.
  aiAnalyticsTtlMs: Number(process.env.AI_ANALYTICS_TTL_MS || 120_000),
  // How long one fleet snapshot is reused. Long enough that a conversation does
  // not re-query the fleet on every message, short enough that "now" is now.
  aiSnapshotTtlMs: Number(process.env.AI_SNAPSHOT_TTL_MS || 15_000),
  // Which language the assistant answers in: 'th', 'en', or 'auto' to follow
  // whatever the question was written in. Not left on auto by default: the
  // system prompt, the metric names and every tool result are English, and a
  // model reading three thousand English tokens answers in English however the
  // question was phrased.
  aiLanguage: (process.env.AI_LANG || 'th').toLowerCase(),
  // The saved conversation is bounded on both axes. It carries the reasoning
  // text and tool traces the page needs to redraw itself, which grows fast, and
  // a jsonb column is not where you want to find out a chat ran to megabytes.
  chatHistoryMax: Number(process.env.CHAT_HISTORY_MAX || 120),
  chatHistoryMaxBytes: Number(process.env.CHAT_HISTORY_MAX_BYTES || 512 * 1024),
  // A local model generating a full report legitimately takes minutes; fetch's
  // default would abandon it long before it finished.
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS || 180_000),
};
