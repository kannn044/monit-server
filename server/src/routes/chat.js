// AI chat.
//
// The shape of a request, and why it is in three phases rather than one:
//
//   route   — classify the question and find the servers it names, so the
//             context can be about that instead of about everything. Packing
//             the whole fleet into every message is what used to push the
//             conversation out of the model's context window.
//   gather  — let the model call read-only tools for what the context does not
//             already contain. This is what turns "answer from what you were
//             given" into "go and look", and it is the difference between
//             counting services and explaining a symptom.
//   answer  — one streaming turn with everything gathered, no tools attached,
//             so the reply comes back token by token.
//
// Gathering is a separate turn on purpose. Detecting tool calls inside a stream
// means reassembling partial JSON argument fragments across chunks, and the
// failure mode is a half-parsed argument silently becoming a wrong query. A
// short non-streaming turn to decide, then a streaming turn to answer, costs
// one extra prefill — which prefix caching largely absorbs — and cannot
// misread its own arguments.

import { q } from '../db/pool.js';
import { requireRole } from '../lib/auth.js';
import { config } from '../config.js';
import { llmChat, llmStream, llmJson, resolveModel, caps, PROFILES } from '../lib/ai-llm.js';
import { fleetSnapshot, snapshotTimings } from '../lib/ai-analytics.js';
import { buildSystemPrompt, routeIntent, PLAN_INSTRUCTION } from '../lib/ai-prompt.js';
import { toolSchemas, toolNames, runTool } from '../lib/ai-tools.js';
import { generateReport, REPORT_KINDS } from '../lib/ai-report.js';

/** Which report a question is asking for, when it is asking for one at all. */
function reportKindFor(text) {
  const t = String(text).toLowerCase();
  if (/ndb|cluster|คลัสเตอร์|topolog|แผนผัง|node group/.test(t)) return 'ndb_topology';
  if (/capacity|เต็ม|forecast|คาดการณ์|พื้นที่|disk/.test(t)) return 'capacity';
  if (/critical|วิกฤต|มีปัญหา|ปัญหา|เสี่ยง/.test(t)) return 'critical';
  return 'fleet_health';
}

const isThai = (s) => /[฀-๿]/.test(String(s));

/** ReAct fallback for a vLLM served without --enable-auto-tool-choice. */
const REACT_SCHEMA = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          args_json: { type: 'string', description: 'Arguments as a JSON object, e.g. {"server":"db-01"}' },
        },
        required: ['tool', 'args_json'],
      },
    },
  },
  required: ['calls'],
};

export default async function chatRoutes(app) {
  app.get('/api/v1/chat/models', { preHandler: requireRole('viewer') }, async (req, reply) => {
    try {
      const res = await fetch(`${config.vllmBaseUrl}/models`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`vLLM returned ${res.status}`);
      const j = await res.json();
      return { models: j.data || [] };
    } catch (e) {
      req.log.error(e, 'failed to fetch vLLM models');
      return reply.code(502).send({ title: 'Cannot reach vLLM', status: 502, detail: e.message });
    }
  });

  /**
   * What this vLLM turned out to support, so the UI can say "tools are off"
   * instead of quietly behaving like the old version and leaving everyone to
   * wonder why the answers got shallower.
   */
  app.get('/api/v1/chat/capabilities', { preHandler: requireRole('viewer') }, async (req) => ({
    base_url: config.vllmBaseUrl,
    model: await resolveModel(req.log).catch(() => null),
    tools: caps.tools,
    guided_json: caps.guidedJson,
    thinking: caps.thinking,
    sql_enabled: config.aiAllowSql,
    tools_available: toolNames(req.user?.role || 'viewer'),
    report_kinds: REPORT_KINDS,
  }));

  /**
   * Where the time goes.
   *
   * "The chat page hangs" has two very different causes — a slow database
   * before the model is ever called, or an unreachable model — and from the
   * outside they look identical. This times each step so the answer is a number
   * rather than a guess.
   */
  app.get('/api/v1/chat/diag', { preHandler: requireRole('admin') }, async () => {
    const steps = await snapshotTimings();
    const t0 = Date.now();
    let vllm;
    try {
      const res = await fetch(`${config.vllmBaseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
      const j = await res.json().catch(() => ({}));
      vllm = { ok: res.ok, status: res.status, ms: Date.now() - t0, models: (j.data || []).map((m) => m.id) };
    } catch (e) {
      vllm = { ok: false, ms: Date.now() - t0, error: e.message };
    }
    return {
      base_url: config.vllmBaseUrl,
      analytics_timeout_ms: config.aiAnalyticsTimeoutMs,
      snapshot_ttl_ms: config.aiSnapshotTtlMs,
      total_db_ms: steps.reduce((a, s) => a + s.ms, 0),
      steps,
      vllm,
      caps,
    };
  });

  app.post('/api/v1/chat/feedback', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id, value } = req.body || {};
    if (!id) return reply.code(400).send({ title: 'id is required', status: 400 });
    await q('UPDATE ai_chat_log SET feedback = $1 WHERE id = $2', [value > 0 ? 1 : -1, id]);
    return { ok: true };
  });

  app.post('/api/v1/chat', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const started = Date.now();
    const { messages = [], model: requestModel } = req.body || {};
    if (!messages.length) {
      return reply.code(400).send({ title: 'messages is required', status: 400 });
    }
    const role = req.user?.role || 'viewer';
    const email = req.user?.email || req.user?.sub || null;
    const question = String(messages[messages.length - 1]?.content || '');

    const lang = isThai(question) ? 'th' : 'en';

    // Take the socket BEFORE any slow work.
    //
    // Assembling the fleet snapshot used to happen first, so a slow database
    // meant the browser sat on a request with no response headers at all — it
    // shows as "pending" for as long as the query takes, the GPU is idle
    // because nothing has reached the model yet, and there is nothing on screen
    // to say which of the two is happening. Headers now go out immediately and
    // every stage announces itself, so a slow step looks like a slow step
    // rather than a hang.
    //
    // hijack() also tells Fastify this route owns the socket from here on.
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

    const send = (obj) => {
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client went away */ }
    };

    const usedTools = [];
    let answerChars = 0;
    let failure = null;
    let route = { intent: 'analyze', servers: [], useTools: false, profile: 'analysis' };

    try {
      send({ t: 'status', s: 'reading' });
      const [snap] = await Promise.all([
        fleetSnapshot({ log: req.log }),
        requestModel || resolveModel(req.log),
      ]);
      route = routeIntent(question, snap);
      send({
        t: 'meta', intent: route.intent, lang,
        tools: caps.tools !== false && route.useTools,
        // Say so out loud rather than quietly answering from less data.
        degraded: !!snap.totals.degraded,
      });

      // ---- report ---------------------------------------------------------
      // A report is not a chat answer that happens to be long: it is a stored
      // artifact with its own permalink, and generating it also produces the
      // summary worth saying out loud. So it short-circuits the whole pipeline.
      if (route.intent === 'report') {
        const kind = reportKindFor(question);
        send({ t: 'status', s: 'report', kind, label: REPORT_KINDS[kind] });
        const row = await generateReport({
          kind, lang, user: email, log: req.log, snap,
          params: { model: requestModel || undefined },
        });
        const { rows } = await q('SELECT narrative FROM ai_reports WHERE id = $1', [row.id]);
        const nar = rows[0]?.narrative || {};
        send({ t: 'report', id: row.id, title: row.title, kind: row.kind });
        const lines = [
          `**${row.title}** — ${REPORT_KINDS[kind]}`,
          '',
          nar.executive_summary || '',
          ...(nar.findings || []).slice(0, 5).map((f) => `- **${f.severity}** ${f.headline}`),
          '',
          lang === 'th' ? 'เปิดรายงานเต็มได้จากการ์ดด้านล่าง' : 'Open the full report from the card below.',
        ].join('\n');
        answerChars = lines.length;
        send({ t: 'delta', c: lines });
        return;
      }

      // ---- gather ---------------------------------------------------------
      const baseSystem = buildSystemPrompt({
        snap, scope: { servers: route.servers }, role,
        toolNames: toolNames(role), mode: route.profile,
      });
      const history = messages.slice(-config.chatMaxHistory, -1)
        .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
        .map(({ role: r, content }) => ({ role: r, content: String(content).slice(0, 4000) }));

      const gathered = [];
      if (route.useTools && config.aiMaxToolRounds > 0) {
        const schemas = toolSchemas(role);
        const planMsgs = [
          { role: 'system', content: `${baseSystem}\n\n${PLAN_INSTRUCTION}` },
          ...history,
          { role: 'user', content: question },
        ];

        for (let round = 0; round < config.aiMaxToolRounds; round++) {
          let calls = [];
          if (caps.tools !== false) {
            const { message, finish } = await llmChat({ messages: planMsgs, profile: 'plan', tools: schemas, log: req.log });
            // Truncated mid-reasoning: no tool calls, no answer, nothing to
            // append. Retrying would truncate at the same place, so go and
            // answer from the context pack — which is never empty.
            if (finish === 'length' && !message.tool_calls?.length) {
              req.log.warn('planning turn hit the token limit before deciding — answering from context');
              break;
            }
            calls = (message.tool_calls || []).map((c) => ({
              id: c.id, name: c.function?.name,
              args: safeParse(c.function?.arguments),
            }));
            // Keep the assistant turn in the transcript so the tool replies
            // that follow have something to be replies *to*.
            if (calls.length) planMsgs.push(message);
            else break;
          } else {
            // No native tool calling on this server — ask for the same decision
            // as constrained JSON. One round only: without real tool messages
            // the model cannot see its own previous results well enough for a
            // second round to be worth the latency.
            if (round > 0) break;
            const plan = await llmJson({
              messages: [
                {
                  role: 'system',
                  content: `${baseSystem}\n\nAvailable tools: ${JSON.stringify(schemas.map((s) => s.function))}\n\n`
                    + 'Return the tool calls you need to answer the question. Return {"calls":[]} if the context above is already enough.',
                },
                { role: 'user', content: question },
              ],
              schema: REACT_SCHEMA, profile: 'plan', log: req.log,
            });
            calls = (plan?.calls || []).slice(0, 4)
              .map((c) => ({ name: c.tool, args: safeParse(c.args_json) }));
            if (!calls.length) break;
          }

          for (const call of calls.slice(0, 4)) {
            if (!call.name) continue;
            send({ t: 'status', s: 'tool', name: call.name, args: call.args });
            const result = await runTool(call.name, call.args, { snap, log: req.log, role });
            usedTools.push(call.name);
            gathered.push({ name: call.name, args: call.args, result });
            send({ t: 'tool_done', name: call.name, chars: result.length });
            if (caps.tools !== false && call.id) {
              planMsgs.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
            }
          }
          if (caps.tools === false) break;
        }
      }

      // ---- answer ---------------------------------------------------------
      let system = baseSystem;
      if (gathered.length) {
        // Folded into the system message rather than left as tool-role turns:
        // the answering call carries no `tools`, and a chat template that sees
        // tool messages without a tool list is free to render them oddly or
        // reject them outright.
        system += `\n\n## Data you just looked up (freshest truth — prefer this over anything above)\n`
          + gathered.map((g) => `### ${g.name}(${JSON.stringify(g.args || {})})\n${g.result}`).join('\n\n');
      }
      send({ t: 'status', s: 'answering' });

      const answerMsgs = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: question },
      ];
      await llmStream({
        messages: answerMsgs,
        profile: route.profile,
        log: req.log,
        onDelta: (c) => { answerChars += c.length; send({ t: 'delta', c }); },
        onThink: (c) => send({ t: 'think', c }),
      });
    } catch (e) {
      failure = e.message;
      req.log.error(e, 'chat failed');
      send({ t: 'error', m: e.message });
    } finally {
      // Telemetry is best-effort: a logging failure must never be the reason a
      // user's answer does not arrive.
      let logId = null;
      try {
        const { rows } = await q(
          `INSERT INTO ai_chat_log (user_email, question, intent, tools, answer_chars, latency_ms, error)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [email, question.slice(0, 2000), route.intent, JSON.stringify(usedTools),
            answerChars, Date.now() - started, failure]);
        logId = rows[0]?.id;
      } catch (e) { req.log.warn(e, 'ai_chat_log insert failed'); }
      if (logId) send({ t: 'logged', id: logId });
      try { reply.raw.write('data: [DONE]\n\n'); } catch { /* ignore */ }
      reply.raw.end();
    }
  });
}

function safeParse(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

// Exported for the eval harness, which needs the same sampling presets the
// live path uses or it is measuring a different system.
export { PROFILES };
