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

/** Fastify preHandler factory: require a JWT user with at least `role`. */
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
    if ((ROLE_RANK[req.user?.role] || 0) < ROLE_RANK[role]) {
      return reply.code(403).send({ title: 'Forbidden', status: 403 });
    }
  };
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
