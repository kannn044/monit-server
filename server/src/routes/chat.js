import { q } from '../db/pool.js';
import { requireRole } from '../lib/auth.js';
import { computeHealth } from '../lib/health.js';
import { config } from '../config.js';

/** Resolve which model to use — explicit config or first from /v1/models. */
async function resolveModel(log) {
  if (config.vllmModel) return config.vllmModel;
  try {
    const res = await fetch(`${config.vllmBaseUrl}/models`);
    if (!res.ok) throw new Error(`models endpoint ${res.status}`);
    const j = await res.json();
    const id = j.data?.[0]?.id;
    if (!id) throw new Error('empty model list');
    return id;
  } catch (e) {
    log.warn(e, 'failed to auto-detect vLLM model, falling back');
    return 'qwen3-8b';
  }
}

/** Build a system prompt packed with live DB context. */
async function buildSystemPrompt() {
  const [
    { rows: servers },
    { rows: incidents },
    { rows: expectedSvc },
  ] = await Promise.all([
    q(`SELECT s.id, s.name, s.ip, s.os, s.last_seen,
         COALESCE((SELECT array_agg(DISTINCT inc.severity) FROM incidents inc
           WHERE inc.server_id = s.id AND inc.status IN ('firing','acknowledged')), '{}') AS active_severities
       FROM servers s WHERE s.archived_at IS NULL ORDER BY s.name`),
    // comparator lives on the rule, not the incident, and the incident's clock
    // column is started_at — incidents has no created_at at all. Joining the
    // rule also gets rule_name/message/value in, which is what actually lets
    // the model say something useful instead of reciting an id.
    q(`SELECT i.id, i.server_id, i.severity, i.status, i.rule_name, i.metric,
              r.comparator, i.threshold, i.value, i.message, i.started_at
         FROM incidents i
         LEFT JOIN alert_rules r ON r.id = i.rule_id
        WHERE i.status IN ('firing','acknowledged')
        ORDER BY i.started_at DESC LIMIT 50`),
    q(`SELECT server_id, kind, name, enabled FROM expected_services ORDER BY server_id, kind, name`),
  ]);

  // Fetch latest PM2/Docker from the most recent sample per server.
  //
  // The time bound is not an optimisation, it is what makes this query usable:
  // without it DISTINCT ON walks every chunk of the hypertable back to the
  // beginning of retention on every single chat message. A server with nothing
  // in the window is offline anyway, and computeHealth() already says so.
  const { rows: latestSamples } = await q(
    `SELECT DISTINCT ON (server_id) server_id, pm2, docker, time
     FROM system_metrics
     WHERE time > now() - ($1::int * interval '1 second')
     ORDER BY server_id, time DESC`,
    [config.sampleIntervalS * config.offlineFactor * 2]);
  const sampleMap = Object.fromEntries(latestSamples.map((s) => [s.server_id, s]));

  const serverLines = servers.map((s) => {
    const health = computeHealth({ last_seen: s.last_seen, activeSeverities: s.active_severities });
    const sample = sampleMap[s.id];
    const pm2List = sample?.pm2 || [];
    const dockerList = sample?.docker || [];
    let line = `- ${s.name} (id=${s.id}, ip=${s.ip || 'N/A'}, os=${s.os || 'N/A'}, health=${health}, last_seen=${s.last_seen || 'never'})`;
    if (pm2List.length) {
      line += `\n  PM2 services (${pm2List.length}): ${pm2List.map((p) => `${p.name}[${p.status}]`).join(', ')}`;
    }
    if (dockerList.length) {
      line += `\n  Docker containers (${dockerList.length}): ${dockerList.map((d) => `${d.name || d.names}[${d.state || d.status}]`).join(', ')}`;
    }
    return line;
  });

  const incidentLines = incidents.map((i) => {
    const cond = i.metric
      ? `${i.metric} ${i.comparator || '?'} ${i.threshold ?? '?'}`
        + (i.value != null ? ` (currently ${i.value})` : '')
      : 'no metric';
    return `- ${i.id}: server=${i.server_id}, severity=${i.severity}, status=${i.status}, `
      + `rule=${i.rule_name || 'n/a'}, ${cond}, since=${i.started_at}`
      + (i.message ? `\n  message: ${i.message}` : '');
  });

  const expectedLines = expectedSvc.map((e) =>
    `- server=${e.server_id}, kind=${e.kind}, name=${e.name}, enabled=${e.enabled}`);

  return `You are an AI assistant for the monit infrastructure monitoring system.
You have access to the following LIVE data (queried just now):

## Servers (${servers.length} total)
${serverLines.join('\n') || '(none)'}

## Active Incidents (${incidents.length})
${incidentLines.join('\n') || '(none)'}

## Expected Services (${expectedSvc.length})
${expectedLines.join('\n') || '(none)'}

Answer questions about the infrastructure concisely. Use the data above to answer questions like:
- How many servers/PM2 services/Docker containers are there
- Which servers have problems
- What services are running on each server
- Current incident status

If the data above does not contain the answer, say so — do not make up information.
Respond in the same language the user writes in (e.g. Thai if they write in Thai).
Keep answers concise and formatted with markdown when helpful.
Use /no_think to disable thinking mode.`;
}

export default async function chatRoutes(app) {
  // List available models
  app.get('/api/v1/chat/models', { preHandler: requireRole('viewer') }, async (req, reply) => {
    try {
      const res = await fetch(`${config.vllmBaseUrl}/models`);
      if (!res.ok) throw new Error(`vLLM returned ${res.status}`);
      const j = await res.json();
      return { models: j.data || [] };
    } catch (e) {
      req.log.error(e, 'failed to fetch vLLM models');
      return reply.code(502).send({ title: 'Cannot reach vLLM', status: 502, detail: e.message });
    }
  });

  // Chat completions — streams SSE back to the client
  app.post('/api/v1/chat', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { messages = [], model: requestModel } = req.body || {};
    if (!messages.length) {
      return reply.code(400).send({ title: 'messages is required', status: 400 });
    }

    const [systemPrompt, model] = await Promise.all([
      buildSystemPrompt(),
      requestModel || resolveModel(req.log),
    ]);

    // Keep only the tail of the transcript. The system prompt grows with the
    // fleet, so a long conversation silently pushes it out of the context
    // window and the model starts answering without any of the live data.
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-config.chatMaxHistory),
    ];

    let upstream;
    try {
      upstream = await fetch(`${config.vllmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: fullMessages,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096,
        }),
      });
    } catch (e) {
      req.log.error(e, 'vLLM connection failed');
      return reply.code(502).send({ title: 'Cannot reach vLLM', status: 502, detail: e.message });
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      req.log.error({ status: upstream.status, body: text }, 'vLLM error');
      return reply.code(502).send({ title: 'vLLM error', status: 502, detail: text || `HTTP ${upstream.status}` });
    }

    // Stream SSE passthrough.
    //
    // hijack() first: it tells Fastify this route owns the socket from here on.
    // Without it the async handler resolves with undefined once the stream is
    // done and Fastify tries to serialise a second response onto a connection
    // that has already been written to and closed.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx buffers proxied responses by default, which holds every token
      // back until the model finishes — the answer then lands in one lump and
      // the stream looks broken. This header turns that off per-response, so a
      // proxy nobody remembered to configure cannot break streaming.
      'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      req.log.error(e, 'stream error');
    } finally {
      reply.raw.end();
    }
  });
}
