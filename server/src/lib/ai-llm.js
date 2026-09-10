// Thin client for the local vLLM (OpenAI-compatible) endpoint.
//
// Everything the chat feature needs to talk to the model lives here so the
// routes can stay about *what* to ask, not about which request fields this
// particular vLLM build happens to accept.
//
// The degradation logic is the point of this file. A vLLM served without
// `--enable-auto-tool-choice` rejects a request carrying `tools` with a 400,
// and a chat template that does not understand `enable_thinking` rejects
// `chat_template_kwargs` the same way. Both are server-side flags nobody can
// change from in here, and both fail as a 400 that looks identical to a bug in
// our own payload. So each optional field is probed once, the answer cached for
// the life of the process, and the request retried without it — the feature
// degrades to a plainer mode instead of the chat page simply not working.

import { config } from '../config.js';
import { estimateTokens } from './ai-prompt.js';

/** Cached model id and, more usefully, the context window it was served with. */
let modelCache = { id: null, maxLen: 0, at: 0 };

/**
 * How many tokens this deployment can actually hold.
 *
 * Taken from /v1/models, which reports the `--max-model-len` vLLM was started
 * with. Asking an operator to keep a number in .env in sync with a flag on
 * another machine is a bug waiting to happen — and getting it wrong is
 * invisible until an answer comes back truncated. AI_MODEL_CONTEXT_TOKENS
 * overrides it when the served value is not the effective one.
 */
export function contextLimit() {
  return config.aiModelContextTokens || modelCache.maxLen || 16384;
}

/** Tokens the prompt may use, leaving the rest for tool results and the reply. */
export function promptBudget() {
  const half = Math.floor(contextLimit() * 0.45);
  return Math.max(1200, Math.min(config.aiPromptBudgetTokens || half, half));
}

/**
 * What this vLLM turned out to accept. `null` = not probed yet.
 * Never re-probed after a definite answer: a 400 here is a server flag, not a
 * transient error, and retrying it on every message doubles the latency of
 * every message.
 */
export const caps = {
  tools: null,
  guidedJson: null,
  thinking: null,
  /**
   * Whether turning thinking OFF still produces a usable reply.
   *
   * It does not on every deployment, and the way it fails is invisible. A vLLM
   * served with `--reasoning-parser deepseek_r1` assumes the model opens in
   * reasoning mode and splits the output at the first `</think>`. Qwen3 with
   * `enable_thinking: false` never emits that tag, so the parser finds no split
   * point and files the ENTIRE reply — answer, tool calls and all — under
   * `reasoning`, handing back `content: null` and `tool_calls: []` with
   * `finish_reason: "stop"`. A complete, correct answer, reported as nothing.
   *
   * Detected the first time it happens and never repeated: after that, thinking
   * stays on for every turn. The right fix is on the server
   * (`--reasoning-parser qwen3`), but this feature cannot depend on someone
   * changing a flag before it works.
   */
  noThinkSafe: null,
};

/** Sampling presets. Qwen3's own recommendation, split by what the turn is for. */
export const PROFILES = {
  // Deciding which tool to call, or classifying a question: as close to
  // deterministic as sampling gets, and short.
  //
  // The token budgets on the two "decide" turns look generous for turns that
  // emit a few dozen tokens. They are sized for the failure case: a vLLM served
  // with --reasoning-parser will emit a reasoning preamble that counts against
  // max_tokens, and if the budget runs out inside that preamble the reply comes
  // back with content: null and tool_calls: [] — a turn that silently did
  // nothing. Cheap insurance; unused budget costs nothing.
  route: { temperature: 0, top_p: 1, max_tokens: 512, thinking: false },
  plan: { temperature: 0.2, top_p: 0.8, top_k: 20, max_tokens: 1400, thinking: false },
  // Reciting a number that is already in the context. Creativity is a defect.
  lookup: { temperature: 0.15, top_p: 0.8, top_k: 20, max_tokens: 900, thinking: false, presence_penalty: 0.5 },
  // Reasoning across servers and time.
  //
  // max_tokens is deliberately modest and thinking is off by default. The
  // ranking, the percentiles and the projections are computed in SQL and handed
  // over as a conclusion, so there is nothing left to reason about — and on a
  // context sized to fit the GPU rather than to be generous, a model that
  // reasons drafts the whole reply inside its thinking and runs out of room
  // before writing a word of it. AI_THINK_ANALYSIS=1 turns it back on for a
  // deployment with room to spare.
  analysis: {
    temperature: 0.4, top_p: 0.9, top_k: 20, max_tokens: 1100,
    thinking: false, presence_penalty: 1.0,
  },
  // Filling a JSON schema: needs to stay on the rails, not explore.
  report: { temperature: 0.35, top_p: 0.9, top_k: 20, max_tokens: 3000, thinking: false, presence_penalty: 1.0 },
};

export async function resolveModel(log) {
  if (config.vllmModel) return config.vllmModel;
  if (modelCache.id && Date.now() - modelCache.at < 5 * 60_000) return modelCache.id;
  try {
    const res = await fetch(`${config.vllmBaseUrl}/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`models endpoint ${res.status}`);
    const j = await res.json();
    const id = j.data?.[0]?.id;
    if (!id) throw new Error('empty model list');
    modelCache = { id, maxLen: Number(j.data[0].max_model_len) || 0, at: Date.now() };
    return id;
  } catch (e) {
    log?.warn(e, 'failed to auto-detect vLLM model');
    // Keep a stale id rather than guessing a name that will 404 on every call.
    if (modelCache.id) return modelCache.id;
    throw new Error(`cannot reach vLLM at ${config.vllmBaseUrl}: ${e.message}`);
  }
}

function buildBody({ model, messages, profile, tools, guidedJson, stream, maxTokens }) {
  const p = PROFILES[profile] || PROFILES.analysis;

  // Leave room to answer.
  //
  // max_tokens is a budget for the REPLY, but the prompt has already spent part
  // of the window. Asking for 1100 output tokens on top of a 5,000-token prompt
  // when the server was started with a small --max-model-len is how a request
  // comes back truncated mid-sentence — or, with a reasoning parser in the way,
  // comes back empty. Measure the prompt and ask for what is actually left.
  const promptTokens = messages.reduce((a, m) => a + estimateTokens(m.content || ''), 0) + 32 * messages.length;
  const room = contextLimit() - promptTokens - 64;
  const want = maxTokens || p.max_tokens;
  const body = {
    model,
    messages,
    stream: !!stream,
    temperature: p.temperature,
    top_p: p.top_p,
    max_tokens: Math.max(256, Math.min(want, room > 0 ? room : want)),
  };
  if (p.top_k !== undefined) body.top_k = p.top_k;
  if (p.presence_penalty !== undefined) body.presence_penalty = p.presence_penalty;

  // Qwen3 is a hybrid reasoning model: this is the switch, and the old prompt
  // was pinning it to "off" for every question by putting /no_think in the
  // system message. Analysis needs it on; a lookup is faster with it off.
  if (config.aiThinking && caps.thinking !== false) {
    // caps.noThinkSafe === false means this server's reasoning parser eats the
    // whole reply when thinking is off, so the cheap mode is not available and
    // every turn thinks.
    const wantThinking = (!!p.thinking || config.aiThinkAnalysis) && profile !== 'plan' && profile !== 'route';
    body.chat_template_kwargs = { enable_thinking: wantThinking || caps.noThinkSafe === false };
  }
  if (tools?.length && caps.tools !== false) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (guidedJson && caps.guidedJson !== false) {
    body.guided_json = guidedJson;
  }

  // Fallback for a chat template that rejected chat_template_kwargs: Qwen3 also
  // honours a bare /no_think in the last user message. Without this, a server
  // whose template does not take the flag would reason its way through every
  // tool-selection turn — the slowest possible way to pick a tool.
  if (!p.thinking && caps.thinking === false && caps.noThinkSafe !== false) {
    const last = body.messages[body.messages.length - 1];
    if (last?.role === 'user' && !String(last.content).includes('/no_think')) {
      body.messages = [...body.messages.slice(0, -1),
        { ...last, content: `${last.content}\n/no_think` }];
    }
  }
  return body;
}

/**
 * POST to vLLM, dropping optional fields one at a time when it rejects them.
 * Returns the raw Response (streaming callers need the body untouched).
 */
async function post(body, log, attempt = 0) {
  let res;
  try {
    res = await fetch(`${config.vllmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
    });
  } catch (e) {
    throw new Error(`cannot reach vLLM: ${e.message}`);
  }
  if (res.ok) {
    // A request that carried an optional field and came back 200 proves the
    // field is supported — remember it so the probe never runs again.
    if (body.tools) caps.tools = true;
    if (body.guided_json) caps.guidedJson = true;
    if (body.chat_template_kwargs) caps.thinking = true;
    return res;
  }

  const text = await res.text().catch(() => '');
  // 400 is the only status worth retrying: it means "this build does not
  // understand that field". A 500 or a 503 is the model being unwell and
  // stripping features will not help.
  if (res.status === 400 && attempt < 3) {
    const next = { ...body };
    let dropped = null;
    if (next.chat_template_kwargs && /enable_thinking|chat_template|template/i.test(text)) {
      delete next.chat_template_kwargs; caps.thinking = false; dropped = 'chat_template_kwargs';
    } else if (next.tools && /tool|function/i.test(text)) {
      delete next.tools; delete next.tool_choice; caps.tools = false; dropped = 'tools';
    } else if (next.guided_json) {
      delete next.guided_json; caps.guidedJson = false; dropped = 'guided_json';
    } else if (next.chat_template_kwargs) {
      delete next.chat_template_kwargs; caps.thinking = false; dropped = 'chat_template_kwargs';
    } else if (next.tools) {
      delete next.tools; delete next.tool_choice; caps.tools = false; dropped = 'tools';
    }
    if (dropped) {
      log?.warn({ dropped, detail: text.slice(0, 300) },
        'vLLM rejected an optional field — retrying without it');
      return post(next, log, attempt + 1);
    }
  }
  throw new Error(`vLLM ${res.status}: ${text.slice(0, 400) || 'no body'}`);
}

/**
 * Tool calls written as Qwen3's XML, for when they arrive as text rather than
 * as a parsed `tool_calls` array.
 *
 *   <tool_call><function=list_servers>
 *     <parameter=health>down</parameter>
 *   </function></tool_call>
 *
 * vLLM normally parses these itself, but not when a reasoning parser has
 * already swallowed the text they were written in. Recovering them here is the
 * difference between a working first request and a silent no-op.
 */
export function parseXmlToolCalls(text) {
  const out = [];
  const blocks = String(text).match(/<tool_call>[\s\S]*?<\/tool_call>/g) || [];
  for (const block of blocks) {
    // Some builds emit JSON inside the wrapper instead of XML.
    const json = block.match(/<tool_call>\s*(\{[\s\S]*\})\s*<\/tool_call>/);
    if (json) {
      try {
        const o = JSON.parse(json[1]);
        if (o.name) {
          out.push({
            id: `call_${out.length}`,
            type: 'function',
            function: { name: o.name, arguments: JSON.stringify(o.arguments ?? o.parameters ?? {}) },
          });
          continue;
        }
      } catch { /* fall through to the XML shape */ }
    }
    const name = block.match(/<function=([^>\s]+)>/)?.[1];
    if (!name) continue;
    const args = {};
    for (const m of block.matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) {
      const raw = m[2].trim();
      // Numbers and booleans come through as text; the tool schemas declare
      // them typed, so coerce the unambiguous ones.
      args[m[1]] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw)
        : raw === 'true' ? true : raw === 'false' ? false : raw;
    }
    out.push({
      id: `call_${out.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return out;
}

const reasoningOf = (m) => m?.reasoning_content || m?.reasoning || '';

/**
 * Undo a reasoning parser that classified the whole reply as reasoning.
 *
 * The signature is unmistakable: the model stopped normally, said nothing, and
 * "thought" something substantial. Treat that thought as the reply.
 */
function salvage(message, finish, log) {
  const reasoning = reasoningOf(message);
  if (message?.content || !reasoning || finish !== 'stop') return message;

  const calls = parseXmlToolCalls(reasoning);
  const text = reasoning.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  if (caps.noThinkSafe === null) {
    caps.noThinkSafe = false;
    log?.warn('this vLLM\'s reasoning parser returns the whole reply as "reasoning" when thinking '
      + 'is disabled — keeping thinking on from now on. Serve with --reasoning-parser qwen3 to fix it properly.');
  }
  return {
    ...message,
    content: text,
    tool_calls: message.tool_calls?.length ? message.tool_calls : calls,
  };
}

/** One non-streaming completion. Returns the first choice's message object. */
export async function llmChat({ messages, profile = 'analysis', tools, guidedJson, maxTokens, log }) {
  const model = await resolveModel(log);
  const res = await post(buildBody({ model, messages, profile, tools, guidedJson, maxTokens }), log);
  const j = await res.json();
  const choice = j.choices?.[0];
  const message = salvage(choice?.message, choice?.finish_reason, log)
    || { role: 'assistant', content: '' };
  return {
    message,
    finish: choice?.finish_reason,
    // With --reasoning-parser configured, vLLM strips the thinking out of
    // content into a field of its own — and has spelled that field both ways
    // across releases. Read both, so the reasoning is never mistaken for an
    // empty reply.
    reasoning: reasoningOf(choice?.message),
    usage: j.usage,
  };
}

/**
 * Streaming completion. Calls onDelta(text) for visible tokens and
 * onThink(text) for the tokens inside a <think> block, so the UI can put the
 * reasoning behind a disclosure instead of throwing it away.
 */
export async function llmStream({ messages, profile = 'analysis', maxTokens, log, onDelta, onThink }) {
  const model = await resolveModel(log);
  const res = await post(buildBody({ model, messages, profile, stream: true, maxTokens }), log);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let thought = '';        // kept in case it turns out to have been the answer
  let finish = null;
  let inThink = false;
  let carry = '';   // holds a partial "<think" that straddles two chunks

  const emit = (text) => {
    // Split the stream on the think markers without ever emitting a partial tag.
    let s = carry + text;
    carry = '';
    while (s) {
      const marker = inThink ? '</think>' : '<think>';
      const at = s.indexOf(marker);
      if (at === -1) {
        // Hold back anything that could be the start of a marker.
        const tail = Math.max(s.lastIndexOf('<'), -1);
        if (tail !== -1 && s.length - tail < marker.length) {
          carry = s.slice(tail);
          s = s.slice(0, tail);
        }
        if (s) (inThink ? onThink : onDelta)?.(s);
        return;
      }
      const before = s.slice(0, at);
      if (before) (inThink ? onThink : onDelta)?.(before);
      inThink = !inThink;
      s = s.slice(at + marker.length);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.choices?.[0]?.finish_reason) finish = parsed.choices[0].finish_reason;
        const delta = parsed.choices?.[0]?.delta;
        // Some builds put the reasoning in its own field instead of <think>,
        // and have named that field both ways across releases.
        const reason = delta?.reasoning_content ?? delta?.reasoning;
        if (reason) { thought += reason; onThink?.(reason); }
        if (delta?.content) { full += delta.content; emit(delta.content); }
      } catch { /* a malformed chunk is not worth killing the answer over */ }
    }
  }
  if (carry) (inThink ? onThink : onDelta)?.(carry);

  // Nothing was emitted as content, but something was emitted as reasoning.
  // Two very different situations, and they must not be treated alike:
  //
  //   finish_reason "stop"   — the model finished, and the reasoning parser
  //                            mislabelled a complete answer. Show it.
  //   finish_reason "length" — the model was still thinking when it ran out of
  //                            budget. That text is a half-finished train of
  //                            thought, in whatever language it thinks in, cut
  //                            off mid-sentence. Showing it as the answer is
  //                            worse than showing nothing: it looks like the
  //                            assistant replied, badly. Return empty and let
  //                            the caller ask again without thinking on.
  if (!full.trim() && thought.trim()) {
    if (finish === 'length') {
      log?.warn({ thoughtChars: thought.length },
        'model spent its whole budget reasoning and never answered — caller should retry without thinking');
    } else {
      if (caps.noThinkSafe === null) caps.noThinkSafe = false;
      log?.warn('streamed reply arrived entirely as reasoning — using it as the answer');
      full = thought.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
      if (full) onDelta?.(full);
    }
  }
  return { text: full, finish, thought };
}

/**
 * Ask for JSON matching a schema.
 *
 * With guided decoding vLLM constrains the sampler to the grammar, so the
 * result parses by construction. Without it (older build, or the field was
 * rejected above) the model is merely asked nicely, so the text is salvaged
 * from the first balanced {...} — good enough, and the caller always has to
 * handle a null anyway.
 */
export async function llmJson({ messages, schema, profile = 'report', maxTokens, log }) {
  let { message, finish } = await llmChat({ messages, profile, guidedJson: schema, maxTokens, log });
  // Ran out of budget before writing any JSON — almost always a long reasoning
  // preamble. One retry with double the room, rather than reporting failure for
  // a model that was about to answer.
  if (!message.content && finish === 'length') {
    const budget = (maxTokens || PROFILES[profile]?.max_tokens || 2000) * 2;
    log?.warn({ budget }, 'model spent its whole budget reasoning — retrying with more room');
    ({ message } = await llmChat({ messages, profile, guidedJson: schema, maxTokens: budget, log }));
  }
  const raw = String(message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch { /* fall through to salvage */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* give up */ }
  }
  log?.warn({ raw: raw.slice(0, 300) }, 'model did not return usable JSON');
  return null;
}
