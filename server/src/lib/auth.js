import crypto from 'node:crypto';
import { q } from '../db/pool.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const generateAgentKey = () => 'sk_agent_' + crypto.randomBytes(24).toString('hex');

/** Look up a non-revoked agent key; returns { server_id, scope } or null. */
export async function verifyAgentKey(bearer) {
  if (!bearer) return null;
  const { rows } = await q(
    `SELECT server_id, scope FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1`,
    [sha256(bearer)]
  );
  return rows[0] || null;
}

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

/**
 * Fastify preHandler factory: require a JWT user with at least `role`.
 *
 * The token is also checked against the database on every request. That costs a
 * primary-key lookup on a tiny table, and it buys two things a stateless JWT
 * cannot give: a password change ends the old sessions immediately, and
 * disabling an account takes effect at once instead of up to 7 days later.
 * Agent ingest does not come through here — it authenticates with a hashed API
 * key — so the hot write path is unaffected.
 */
export function requireRole(role) {
  return async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ title: 'Unauthorized', status: 401 });
    }
    if (req.user?.typ !== 'access') {
      return reply.code(401).send({ title: 'Unauthorized', status: 401 });
    }
    const live = await currentUser(req.user?.sub);
    if (!live) return reply.code(401).send({ title: 'Unauthorized', status: 401 });
    if (live.disabled) {
      return reply.code(401).send({ title: 'Account disabled', status: 401 });
    }
    if ((req.user?.tv ?? 0) !== live.token_version) {
      return reply.code(401).send({
        title: 'Session ended', status: 401,
        detail: 'The password for this account changed — sign in again.',
      });
    }
    // The database is the authority on role, so a promotion or demotion applies
    // to the session already open rather than to the next one.
    req.user.role = live.role;
    if ((ROLE_RANK[live.role] || 0) < ROLE_RANK[role]) {
      return reply.code(403).send({ title: 'Forbidden', status: 403 });
    }
  };
}

/** Current role / disabled / token_version straight from the users table. */
export async function currentUser(id) {
  if (!id) return null;
  const { rows } = await q(
    'SELECT id, email, name, role, disabled, token_version FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function audit(req, action, entity, entityId, detail = null) {
  try {
    await q(
      `INSERT INTO audit_log (user_id, user_email, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user?.sub || null, req.user?.email || null, action, entity, String(entityId ?? ''), detail]
    );
  } catch (e) {
    req.log.warn({ err: e }, 'audit log failed');
  }
}
