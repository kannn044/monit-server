import bcrypt from 'bcryptjs';
import { q } from '../db/pool.js';
import { config } from '../config.js';
import { requireRole, audit } from '../lib/auth.js';
import { randomToken } from '../lib/secrets.js';

export default async function authRoutes(app) {
  app.post('/api/v1/auth/login', {
    schema: {
      body: {
        type: 'object', required: ['email', 'password'],
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body;
    const { rows } = await q('SELECT * FROM users WHERE email = $1 AND NOT disabled', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ title: 'Invalid credentials', status: 401 });
    }
    // tv pins the token to the account's current token_version; changing the
    // password bumps it and every token minted before this moment stops working.
    const claims = { sub: user.id, email: user.email, name: user.name, role: user.role, tv: user.token_version };
    return {
      access_token: app.jwt.sign({ ...claims, typ: 'access' }, { expiresIn: config.accessTokenTtl }),
      refresh_token: app.jwt.sign({ sub: user.id, tv: user.token_version, typ: 'refresh' },
        { expiresIn: config.refreshTokenTtl }),
      user: claims,
    };
  });

  app.post('/api/v1/auth/refresh', {
    schema: { body: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } },
  }, async (req, reply) => {
    let payload;
    try {
      payload = app.jwt.verify(req.body.refresh_token);
    } catch {
      return reply.code(401).send({ title: 'Invalid refresh token', status: 401 });
    }
    if (payload.typ !== 'refresh') return reply.code(401).send({ title: 'Invalid refresh token', status: 401 });
    const { rows } = await q('SELECT * FROM users WHERE id = $1 AND NOT disabled', [payload.sub]);
    const user = rows[0];
    if (!user) return reply.code(401).send({ title: 'User not found', status: 401 });
    // A refresh token minted before a password change must not mint new access
    // tokens — otherwise the 7-day refresh window would outlive the password.
    if ((payload.tv ?? 0) !== user.token_version) {
      return reply.code(401).send({
        title: 'Session ended', status: 401,
        detail: 'The password for this account changed — sign in again.',
      });
    }
    const claims = { sub: user.id, email: user.email, name: user.name, role: user.role, tv: user.token_version };
    return {
      access_token: app.jwt.sign({ ...claims, typ: 'access' }, { expiresIn: config.accessTokenTtl }),
      user: claims,
    };
  });

  // ---- Change your own password (any signed-in role) ----
  // Requires the current password: a stolen access token must not be enough to
  // take an account over permanently.
  app.post('/api/v1/auth/change-password', {
    preHandler: requireRole('viewer'),
    schema: {
      body: {
        type: 'object', required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string' },
          new_password: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const { current_password: cur, new_password: next } = req.body;
    const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const user = rows[0];
    if (!user) return reply.code(401).send({ title: 'Unauthorized', status: 401 });
    if (!(await bcrypt.compare(cur, user.password_hash))) {
      return reply.code(400).send({ title: 'Current password is incorrect', status: 400 });
    }
    if (await bcrypt.compare(next, user.password_hash)) {
      return reply.code(400).send({ title: 'The new password must differ from the current one', status: 400 });
    }
    const { rows: upd } = await q(
      `UPDATE users SET password_hash = $2, token_version = token_version + 1
       WHERE id = $1 RETURNING token_version`,
      [req.user.sub, await bcrypt.hash(next, 10)]);
    await audit(req, 'user.password_change', 'user', req.user.sub, { self: true });
    // Hand back a fresh pair so the caller is not logged out by its own change.
    const claims = { sub: user.id, email: user.email, name: user.name, role: user.role, tv: upd[0].token_version };
    return {
      ok: true,
      access_token: app.jwt.sign({ ...claims, typ: 'access' }, { expiresIn: config.accessTokenTtl }),
      refresh_token: app.jwt.sign({ sub: user.id, tv: upd[0].token_version, typ: 'refresh' },
        { expiresIn: config.refreshTokenTtl }),
      user: claims,
    };
  });

  app.get('/api/v1/auth/me', { preHandler: requireRole('viewer') }, async (req) => ({
    user: { sub: req.user.sub, email: req.user.email, name: req.user.name, role: req.user.role },
  }));

  // ---- User management (admin) ----
  app.get('/api/v1/users', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await q('SELECT id, email, name, role, disabled, created_at FROM users ORDER BY created_at');
    return { users: rows };
  });

  app.post('/api/v1/users', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object', required: ['email', 'password', 'role'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name: { type: 'string' },
          role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password, name = '', role } = req.body;
    const hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await q(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)
         RETURNING id, email, name, role, disabled, created_at`,
        [email.toLowerCase(), name, hash, role]
      );
      await audit(req, 'user.create', 'user', rows[0].id, { email, role });
      return reply.code(201).send({ user: rows[0] });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ title: 'Email already exists', status: 409 });
      throw e;
    }
  });

  app.patch('/api/v1/users/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
          disabled: { type: 'boolean' },
          password: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const { name, role, disabled, password } = req.body;

    // Losing the last admin locks everyone out of user management, alert rules
    // and channels with no way back in through the UI. Demoting or disabling
    // the final one is refused for the same reason deleting it is.
    if (role !== undefined || disabled !== undefined) {
      const losingAdmin = (role !== undefined && role !== 'admin') || disabled === true;
      if (losingAdmin && await isLastActiveAdmin(req.params.id)) {
        return reply.code(409).send({
          title: 'This is the last active admin', status: 409,
          detail: 'Promote another user to admin first, otherwise nobody could manage the system.',
        });
      }
    }

    const sets = []; const vals = []; let i = 1;
    if (name !== undefined) { sets.push(`name = $${i++}`); vals.push(name); }
    if (role !== undefined) { sets.push(`role = $${i++}`); vals.push(role); }
    if (disabled !== undefined) { sets.push(`disabled = $${i++}`); vals.push(disabled); }
    if (password !== undefined) {
      sets.push(`password_hash = $${i++}`); vals.push(await bcrypt.hash(password, 10));
      // An admin resetting a password is usually responding to it being lost or
      // exposed, so the old sessions have to go too.
      sets.push('token_version = token_version + 1');
    }
    // Disabling an account should log it out now, not whenever its token lapses.
    if (disabled === true) sets.push('token_version = token_version + 1');
    if (!sets.length) return reply.code(400).send({ title: 'Nothing to update', status: 400 });
    vals.push(req.params.id);
    const { rows } = await q(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, email, name, role, disabled`, vals);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'user.update', 'user', req.params.id, req.body.password ? { ...req.body, password: '***' } : req.body);
    return { user: rows[0] };
  });

  app.delete('/api/v1/users/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    if (req.params.id === req.user.sub) {
      return reply.code(409).send({
        title: 'You cannot delete your own account', status: 409,
        detail: 'Ask another admin to remove it.',
      });
    }
    if (await isLastActiveAdmin(req.params.id)) {
      return reply.code(409).send({
        title: 'This is the last active admin', status: 409,
        detail: 'Promote another user to admin first, otherwise nobody could manage the system.',
      });
    }
    const { rows } = await q(
      'DELETE FROM users WHERE id = $1 RETURNING email, role', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    // audit_log keeps user_email as plain text and has no foreign key to users,
    // so what this account did stays on the record after the row is gone.
    await audit(req, 'user.delete', 'user', req.params.id, rows[0]);
    return { ok: true, deleted: rows[0].email };
  });

}

/**
 * Create the initial admin user when the users table is empty.
 * With no ADMIN_PASSWORD set, a random one is generated and printed once —
 * better than shipping a known default nobody remembers to change.
 */
/** True when `id` is the only admin left that can still sign in. */
async function isLastActiveAdmin(id) {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM users
      WHERE role = 'admin' AND NOT disabled AND id <> $1`, [id]);
  return rows[0].n === 0;
}

export async function seedAdmin(log = console) {
  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  const generated = !config.adminPassword;
  const password = config.adminPassword || randomToken(12);
  const hash = await bcrypt.hash(password, 10);
  await q(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin')`,
    [config.adminEmail.toLowerCase(), hash]
  );

  if (generated) {
    const banner = '='.repeat(64);
    log.warn?.(`\n${banner}\n  ADMIN ACCOUNT CREATED — this password is shown ONCE\n`
      + `    email:    ${config.adminEmail}\n`
      + `    password: ${password}\n`
      + `  Sign in, then change it under Settings.\n${banner}\n`);
  } else {
    log.info?.(`[seed] created admin user ${config.adminEmail} (password from ADMIN_PASSWORD)`);
  }
}
