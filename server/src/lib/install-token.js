// One-time install tokens.
//
// The problem this solves: to install an agent, someone has to get the agent
// key onto the target machine. Every way of carrying it by hand is a way of
// leaving it somewhere — a downloaded file in ~/Downloads, a line in .bash_history,
// a paste in a chat window. The key is long-lived, so each of those copies stays
// dangerous indefinitely.
//
// So the key is not carried at all. The dashboard mints a token that is good for
// one redemption within 15 minutes; the person pastes one line on the machine
// they are installing on; the server hands back the key over that single
// request, straight into the installer's memory.
//
// The token is stored only as a SHA-256 — a database dump cannot be replayed.
// The agent key is stored alongside it, but encrypted under a key derived from
// the RAW token, which the database never sees. So the row is inert on its own:
// whoever holds the token can open it, and nobody else, including us.
import crypto from 'node:crypto';
import { q } from '../db/pool.js';
import { sha256 } from './auth.js';

const TTL_MINUTES = 15;

// URL-safe and unambiguous: the token travels in a URL that people read off a
// screen and retype when the copy button is not available to them.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomToken(len = 32) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// scrypt rather than a bare hash: the token is high-entropy so this is belt and
// braces, but it costs one derivation per redemption and nothing per request.
const wrapKey = (rawToken) => crypto.scryptSync(rawToken, 'monit-install-token', 32);

function wrap(rawToken, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', wrapKey(rawToken), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function unwrap(rawToken, packed) {
  const buf = Buffer.from(packed, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', wrapKey(rawToken), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Mint a token that will hand `apiKey` back once.
 * Returns { token, expiresAt } — `token` is the only copy that will ever exist.
 */
export async function mintInstallToken({ serverId, apiKey, userId = null, baseUrl = null }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000);
  // baseUrl is stored, not recomputed at redemption: see 013_install_token_base_url.sql.
  await q(
    `INSERT INTO install_tokens (token_hash, server_id, key_wrapped, created_by, expires_at, base_url)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sha256(token), serverId, wrap(token, apiKey), userId, expiresAt, baseUrl]
  );
  return { token, expiresAt, ttlMinutes: TTL_MINUTES };
}

/**
 * Redeem a token. Returns { serverId, apiKey } or throws an Error carrying a
 * `reason` of 'unknown' | 'used' | 'expired'.
 *
 * The claim is a single UPDATE with the used/expiry test in its WHERE clause, so
 * two simultaneous redemptions cannot both win: whichever transaction commits
 * first sets used_at, and the other matches no row.
 */
export async function redeemInstallToken(token, ip = null) {
  const hash = sha256(String(token || ''));
  const { rows } = await q(
    `UPDATE install_tokens
        SET used_at = now(), used_from = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING server_id, key_wrapped, base_url`,
    [hash, ip]
  );

  if (!rows[0]) {
    // Say precisely why. "Already used" and "never existed" send someone to two
    // completely different places, and the token is spent either way.
    const { rows: probe } = await q(
      `SELECT used_at, expires_at <= now() AS expired FROM install_tokens WHERE token_hash = $1`,
      [hash]
    );
    const err = new Error(
      !probe[0] ? 'unknown install token'
        : probe[0].used_at ? 'this install token has already been used'
          : 'this install token has expired');
    err.reason = !probe[0] ? 'unknown' : probe[0].used_at ? 'used' : 'expired';
    throw err;
  }

  let apiKey;
  try {
    apiKey = unwrap(token, rows[0].key_wrapped);
  } catch {
    // Only reachable if the row was tampered with; the token hash matched, so
    // the token itself is right.
    const err = new Error('install token could not be opened');
    err.reason = 'corrupt';
    throw err;
  }
  return { serverId: rows[0].server_id, apiKey, baseUrl: rows[0].base_url || null };
}

/** Drop spent and expired rows. Cheap, and keeps the table from growing forever. */
export async function sweepInstallTokens() {
  const { rowCount } = await q(
    `DELETE FROM install_tokens WHERE expires_at < now() - interval '1 day'`);
  return rowCount;
}
