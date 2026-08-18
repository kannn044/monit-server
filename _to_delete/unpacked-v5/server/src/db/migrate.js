// Simple migration runner.
// Files in ../migrations run in filename order; each file is split on `--;;`
// and every chunk runs as its own statement (continuous aggregates cannot be
// created inside a transaction, so no explicit transactions are used).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

const firstLine = (e) => String(e?.message || e).split('\n')[0];

/**
 * Is TimescaleDB actually usable on this database?
 *
 * Checking `pg_available_extensions` is not enough: the package can be present
 * on disk while `CREATE EXTENSION` still fails because the library is missing
 * from `shared_preload_libraries` (needs a postgresql.conf edit + restart), or
 * because the connecting role may not create extensions. Both are common on a
 * pre-existing PostgreSQL server, so probe by actually trying it and degrade to
 * the plain-PostgreSQL path when it does not work.
 */
async function detectTimescale() {
  const { rows: installed } = await pool.query(
    `SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`);
  if (installed.length) return true;

  const { rows: available } = await pool.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'`);
  if (!available.length) {
    console.warn('[migrate] timescaledb is not installed on this server — using the plain-PostgreSQL path');
    return false;
  }

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    console.log('[migrate] timescaledb enabled');
    return true;
  } catch (e) {
    console.warn(`[migrate] timescaledb is installed but could not be enabled: ${firstLine(e)}`);
    console.warn("[migrate]   → usually means it is missing from shared_preload_libraries, "
      + 'or this role cannot create extensions');
    console.warn('[migrate]   → continuing on the plain-PostgreSQL path');
    return false;
  }
}

/**
 * Chunk directives (first line of a chunk):
 *   -- @timescale  run only when TimescaleDB is usable
 *   -- @vanilla    run only when it is not (plain-PostgreSQL fallback)
 *   -- @optional   log and continue if the statement fails
 */
export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const hasTimescale = await detectTimescale();
  if (!hasTimescale) {
    console.warn('[migrate] running WITHOUT hypertables, compression, or retention policies. '
      + 'Metrics still work; prune system_metrics yourself, or install TimescaleDB.');
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const chunks = sql.split(/^--;;\s*$/m).map((c) => c.trim()).filter(Boolean);
    console.log(`[migrate] applying ${file} (${chunks.length} statements)`);
    for (const chunk of chunks) {
      if (/^--\s*@timescale\b/m.test(chunk) && !hasTimescale) continue;
      if (/^--\s*@vanilla\b/m.test(chunk) && hasTimescale) continue;
      const optional = /^--\s*@optional\b/m.test(chunk);
      try {
        await pool.query(chunk);
      } catch (e) {
        if (!optional) {
          console.error(`[migrate] FAILED in ${file}:\n${chunk.slice(0, 300)}`);
          throw e;
        }
        console.warn(`[migrate] optional statement skipped (${firstLine(e)})`);
      }
    }
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  }
  console.log('[migrate] up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
