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

/** Cached model id from /v1/models. */
let modelCache = { id: null, at: 0 };

/**
 * What this vLLM turned out to accept. `null` = not probed yet.
 * Never re-probed after a definite answer: a 400 here is a server flag, not a
 * transient error, and retrying it on every message doubles the latency of
 * every message.
 */
export const caps = { tools: null, guidedJson: null, thinking: null };

/** Sampling presets. Qwen3's own recommendation, split by what the turn is for. */
export const PROFILES = {
  // Deciding which tool to call, or classifying a question: as close to
  // deterministic as sampling gets, and short.
  route: { temperature: 0, top_p: 1, max_tokens: 220, thinking: false },
  plan: { temperature: 0.2, top_p: 0.8, top_k: 20, max_tokens: 768, thinking: false },
  // Reciting a number that is already in the context. Creativity is a defect.
  lookup: { temperature: 0.15, top_p: 0.8, top_k: 20, max_tokens: 900, thinking: false, presence_penalty: 0.5 },
  // Reasoning across servers and time. Qwen3's thinking-mode numbers.
  analysis: {
    temperature: 0.6, top_p: 0.95, top_k: 20, max_tokens: 2600,
    thinking: true, presence_penalty: 1.0,
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
    modelCache = { id, at: Date.now() };
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
  const body = {
    model,
    messages,
    stream: !!stream,
    temperature: p.temperature,
    top_p: p.top_p,
    max_tokens: maxTokens || p.max_tokens,
  };
  if (p.top_k !== undefined) body.top_k = p.top_k;
  if (p.presence_penalty !== undefined) body.presence_penalty = p.presence_penalty;

  // Qwen3 is a hybrid reasoning model: this is the switch, and the old prompt
  // was pinning it to "off" for every question by putting /no_think in the
  // system message. Analysis needs it on; a lookup is faster with it off.
  if (config.aiThinking && caps.thinking !== false) {
    body.chat_template_kwargs = { enable_thinking: !!p.thinking };
  }
  if (tools?.length && caps.tools !== false) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (guidedJson && caps.guidedJson !== false) {
    body.guided_json = guidedJson;
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

/** One non-streaming completion. Returns the first choice's message object. */
export async function llmChat({ messages, profile = 'analysis', tools, guidedJson, maxTokens, log }) {
  const model = await resolveModel(log);
  const res = await post(buildBody({ model, messages, profile, tools, guidedJson, maxTokens }), log);
  const j = await res.json();
  const choice = j.choices?.[0];
  return {
    message: choice?.message || { role: 'assistant', content: '' },
    finish: choice?.finish_reason,
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
        const delta = parsed.choices?.[0]?.delta;
        // Some builds put the reasoning in its own field instead of <think>.
        if (delta?.reasoning_content) onThink?.(delta.reasoning_content);
        if (delta?.content) { full += delta.content; emit(delta.content); }
      } catch { /* a malformed chunk is not worth killing the answer over */ }
    }
  }
  if (carry) (inThink ? onThink : onDelta)?.(carry);
  return full;
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
  const { message } = await llmChat({ messages, profile, guidedJson: schema, maxTokens, log });
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
