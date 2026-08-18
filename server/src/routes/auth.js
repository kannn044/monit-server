import bcrypt from 'bcryptjs';
import { q } from '../db/pool.js';
import { config } from '../config.js';
import { requireRole, audit } from '../lib/auth.js';

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
    const claims = { sub: user.id, email: user.email, name: user.name, role: user.role };
    return {
      access_token: app.jwt.sign({ ...claims, typ: 'access' }, { expiresIn: config.accessTokenTtl }),
      refresh_token: app.jwt.sign({ sub: user.id, typ: 'refresh' }, { expiresIn: config.refreshTokenTtl }),
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
    const claims = { sub: user.id, email: user.email, name: user.name, role: user.role };
    return {
      access_token: app.jwt.sign({ ...claims, typ: 'access' }, { expiresIn: config.accessTokenTtl }),
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
    const sets = []; const vals = []; let i = 1;
    if (name !== undefined) { sets.push(`name = $${i++}`); vals.push(name); }
    if (role !== undefined) { sets.push(`role = $${i++}`); vals.push(role); }
    if (disabled !== undefined) { sets.push(`disabled = $${i++}`); vals.push(disabled); }
    if (password !== undefined) { sets.push(`password_hash = $${i++}`); vals.push(await bcrypt.hash(password, 10)); }
    if (!sets.length) return reply.code(400).send({ title: 'Nothing to update', status: 400 });
    vals.push(req.params.id);
    const { rows } = await q(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, email, name, role, disabled`, vals);
    if (!rows[0]) return reply.code(404).send({ title: 'Not found', status: 404 });
    await audit(req, 'user.update', 'user', req.params.id, req.body.password ? { ...req.body, password: '***' } : req.body);
    return { user: rows[0] };
  });
}

/** Create the initial admin user from env if the users table is empty. */
export async function seedAdmin() {
  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const hash = await bcrypt.hash(config.adminPassword, 10);
  await q(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin')`,
    [config.adminEmail.toLowerCase(), hash]
  );
  console.log(`[seed] created admin user ${config.adminEmail}`);
}
