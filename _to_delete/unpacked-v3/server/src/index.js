import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PgBoss from 'pg-boss';

import { config } from './config.js';
import { migrate } from './db/migrate.js';
import authRoutes, { seedAdmin } from './routes/auth.js';
import ingestRoutes from './routes/ingest.js';
import serverRoutes from './routes/servers.js';
import projectRoutes from './routes/projects.js';
import metricsRoutes from './routes/metrics.js';
import alertRoutes from './routes/alerts.js';
import { startNotifier } from './workers/notifier.js';
import { startAlertEngine } from './workers/alert-engine.js';
import { resolveJwtSecret } from './lib/secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await migrate();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 1024 * 1024,
  });

  const jwt = await resolveJwtSecret(config.jwtSecret);
  if (jwt.source === 'generated') {
    app.log.info('[auth] generated a JWT signing secret and stored it in app_settings');
  }
  await seedAdmin(app.log);

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyJwt, { secret: jwt.secret });

  // RFC 7807-style error shape
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).type('application/problem+json').send({
      title: status >= 500 ? 'Internal Server Error' : err.message,
      status,
      detail: status >= 500 ? undefined : err.message,
    });
  });

  app.get('/api/v1/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(ingestRoutes);
  await app.register(serverRoutes);
  await app.register(projectRoutes);
  await app.register(metricsRoutes);
  await app.register(alertRoutes);

  // Serve the built dashboard (public/) with SPA fallback
  const publicDir = path.join(__dirname, '../public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).type('application/problem+json').send({ title: 'Not Found', status: 404 });
      }
      return reply.sendFile('index.html');
    });
  }

  // Job queue + workers
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });
  boss.on('error', (e) => app.log.error(e, 'pg-boss error'));
  await boss.start();
  await startNotifier(boss, app.log);
  startAlertEngine(boss, app.log);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`monit-server listening on :${config.port}`);

  const shutdown = async () => {
    app.log.info('shutting down');
    await boss.stop({ graceful: true }).catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
