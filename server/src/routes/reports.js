// Stored AI reports.
//
// The HTML comes back inside JSON rather than being served as a page of its
// own. Serving it directly would mean a URL a browser opens without an
// Authorization header, which for authenticated content means either a cookie
// or a signed link — a whole auth mechanism this app does not otherwise have,
// bolted on so that one iframe can load. The dashboard renders the string into
// a sandboxed iframe instead, and the download button builds a blob from it.

import { q } from '../db/pool.js';
import { requireRole } from '../lib/auth.js';
import { createPendingReport, fillReport, REPORT_KINDS } from '../lib/ai-report.js';

export default async function reportRoutes(app) {
  app.get('/api/v1/reports', { preHandler: requireRole('viewer') }, async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    const { rows } = await q(
      `SELECT id, kind, title, status, error, created_by, created_at,
              (dataset->>'subtitle')            AS subtitle,
              jsonb_array_length(COALESCE(narrative->'findings','[]'::jsonb)) AS findings
         FROM ai_reports ORDER BY created_at DESC LIMIT $1`, [limit]);
    return { kinds: REPORT_KINDS, reports: rows };
  });

  app.get('/api/v1/reports/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { rows } = await q('SELECT * FROM ai_reports WHERE id = $1', [req.params.id]);
    if (!rows.length) return reply.code(404).send({ title: 'Not Found', status: 404 });
    return rows[0];
  });

  app.post('/api/v1/reports', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const kind = String(req.body?.kind || 'fleet_health');
    if (!REPORT_KINDS[kind]) {
      return reply.code(400).send({
        title: 'Unknown report kind', status: 400,
        detail: `Pick one of: ${Object.keys(REPORT_KINDS).join(', ')}`,
      });
    }
    const lang = req.body?.lang === 'en' ? 'en' : 'th';
    const params = { lang };

    // Claim the row, answer immediately, then do the work.
    //
    // The model call takes a minute or more on a local GPU. Holding the request
    // open for it gave the page nothing to show but a disabled button, and
    // anything slower than nginx's proxy_read_timeout came back as a 504 —
    // which looked like the report had failed even though the server went on to
    // finish and store it. The client polls GET /reports/:id instead.
    const row = await createPendingReport({ kind, params, user: req.user?.email || req.user?.sub });
    fillReport(row.id, { kind, params, lang, log: req.log })
      .catch(() => { /* fillReport already recorded the reason on the row */ });
    return reply.code(202).send(row);
  });

  app.delete('/api/v1/reports/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await q('DELETE FROM ai_reports WHERE id = $1', [req.params.id]);
    return reply.code(204).send();
  });
}
