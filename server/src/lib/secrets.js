import crypto from 'node:crypto';
import { q } from '../db/pool.js';

/** URL-safe random string (no +, /, = — safe inside a connection string). */
export const randomToken = (bytes = 24) =>
  crypto.randomBytes(bytes).toString('base64url').slice(0, Math.ceil((bytes * 4) / 3));

/**
 * JWT signing secret.
 *
 * Uses JWT_SECRET when set. Otherwise generates one and stores it in
 * app_settings, so a zero-config install is still secure and sessions survive
 * restarts. ON CONFLICT + re-select keeps concurrent replicas on one value.
 */
export async function resolveJwtSecret(envSecret) {
  if (envSecret) return { secret: envSecret, source: 'env' };

  const { rows } = await q(`SELECT value FROM app_settings WHERE key = 'jwt_secret'`);
  if (rows[0]) return { secret: rows[0].value, source: 'database' };

  await q(
    `INSERT INTO app_settings (key, value) VALUES ('jwt_secret', $1)
     ON CONFLICT (key) DO NOTHING`,
    [crypto.randomBytes(48).toString('base64')]
  );
  const { rows: after } = await q(`SELECT value FROM app_settings WHERE key = 'jwt_secret'`);
  return { secret: after[0].value, source: 'generated' };
}
