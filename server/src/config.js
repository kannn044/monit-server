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
};
