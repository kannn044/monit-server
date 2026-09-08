import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PgBoss from 'pg-boss';

import { config, envFile } from './config.js';
import { migrate } from './db/migrate.js';
import authRoutes, { seedAdmin } from './routes/auth.js';
import ingestRoutes from './routes/ingest.js';
import serverRoutes from './routes/servers.js';
import projectRoutes from './routes/projects.js';
import metricsRoutes from './routes/metrics.js';
import alertRoutes from './routes/alerts.js';
import installRoutes from './routes/install.js';
import { startNotifier } from './workers/notifier.js';
import { startAlertEngine } from './workers/alert-engine.js';
import { resolveJwtSecret } from './lib/secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Say which .env was used. "I edited .env and nothing changed" is impossible
  // to diagnose from the outside, and there are two plausible locations.
  if (envFile) console.log(`[config] loaded ${envFile}`);

  if (config.readOnly) {
    // Printed loudly and before anything else: the whole point is that someone
    // remembers this process is pointed at a database it does not own.
    const dsn = config.databaseUrl.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
    console.warn('\n'
      + '  ┌─ MONIT_READONLY ───────────────────────────────────────────────\n'
      + '  │  Migrations, the alert engine and the notifier are all OFF.\n'
      + '  │  Nothing here will change the schema or send a notification.\n'
      + `  │  Database: ${dsn}\n`
      + '  └────────────────────────────────────────────────────────────────\n');
  } else {
    await migrate();
  }

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
  // Registered before the static handler so /install/:token is not mistaken for
  // a dashboard route and answered with index.html.
  await app.register(installRoutes);

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
  //
  // pg-boss is skipped entirely rather than started and left idle: starting it
  // creates and migrates its own `pgboss` schema, which is exactly the kind of
  // write this mode exists to avoid.
  let boss = null;
  if (config.readOnly) {
    app.log.warn('[readonly] alert engine and notifier not started');
  } else {
    boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });
    boss.on('error', (e) => app.log.error(e, 'pg-boss error'));
    await boss.start();
    await startNotifier(boss, app.log);
    startAlertEngine(boss, app.log);
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`monit-server listening on :${config.port}`);

  const shutdown = async () => {
    app.log.info('shutting down');
    await boss?.stop({ graceful: true }).catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * The database is unreachable more often than anything else goes wrong at
 * startup — usually because nothing has been started yet on a fresh checkout.
 * A raw `ECONNREFUSED 127.0.0.1:5432` and a stack trace through pg-pool does
 * not say that, so translate the handful of causes that have an obvious fix and
 * leave everything else exactly as it was.
 */
function explain(e) {
  const url = config.databaseUrl.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
  switch (e?.code) {
    case 'ECONNREFUSED':
      return `Nothing is listening for PostgreSQL at ${e.address}:${e.port}.\n\n`
        + `  The app is trying:  ${url}\n\n`
        + '  Start a database, then run this again:\n'
        + '    docker start monit-pg    # if you made it before\n'
        + '    docker run -d --name monit-pg -p 5432:5432 \\\n'
        + '      -e POSTGRES_USER=monit -e POSTGRES_PASSWORD=monit_dev_password \\\n'
        + '      -e POSTGRES_DB=monit postgres:16\n\n'
        + '  Already have a PostgreSQL elsewhere? Point DATABASE_URL at it.\n'
        + '  See docs/DEVELOPMENT.md.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The database host "${e.hostname}" does not resolve.\n\n`
        + `  The app is trying:  ${url}\n\n`
        + '  In Docker this normally means the app and the database are not on the\n'
        + '  same network — run ./check-db-network.sh on the central server.';
    case '28P01':
      return `PostgreSQL refused the password for that user.\n\n  Trying: ${url}`;
    case '3D000':
      return `That database does not exist yet.\n\n  Trying: ${url}\n\n`
        + '  Create it, or run ./setup-db.sh.';
    default:
      return null;
  }
}

main().catch((e) => {
  const hint = explain(e);
  if (hint) {
    console.error(`\n✗ cannot start: ${hint}\n`);
    if (process.env.LOG_LEVEL === 'debug') console.error(e);
  } else {
    console.error(e);
  }
  process.exit(1);
});
