// Simple migration runner.
// Files in ../migrations run in filename order; each file is split on `--;;`
// and every chunk runs as its own statement (continuous aggregates cannot be
// created inside a transaction, so no explicit transactions are used).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Chunk directives:
//   -- @timescale  → run only when the timescaledb extension is available
//   -- @vanilla    → run only when it is NOT (plain-PostgreSQL fallback)
export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const { rows: ext } = await pool.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'`);
  const hasTimescale = ext.length > 0;
  if (!hasTimescale) {
    console.warn('[migrate] timescaledb extension NOT available — falling back to plain PostgreSQL '
      + '(no hypertables/compression/retention; fine for small fleets and testing)');
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
      if (/^--\s*@timescale\b/.test(chunk) && !hasTimescale) continue;
      if (/^--\s*@vanilla\b/.test(chunk) && hasTimescale) continue;
      await pool.query(chunk);
    }
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  }
  console.log('[migrate] up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
