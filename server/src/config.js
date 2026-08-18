export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || 'postgres://monit:monit_dev_password@127.0.0.1:5432/monit',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme-now',
  sampleIntervalS: Number(process.env.SAMPLE_INTERVAL_S || 10),
  alertTickS: Number(process.env.ALERT_TICK_S || 30),
  ingestMaxBodyBytes: 256 * 1024,
  // per-server ingest rate limit: max requests per window.
  // Raise INGEST_RATE_MAX temporarily when backfilling historical samples.
  ingestRateLimit: {
    max: Number(process.env.INGEST_RATE_MAX || 12),
    windowMs: Number(process.env.INGEST_RATE_WINDOW_MS || 10_000),
  },
  accessTokenTtl: '15m',
  refreshTokenTtl: '7d',
  // "offline" = no sample for offlineFactor × interval
  offlineFactor: 3,
};
