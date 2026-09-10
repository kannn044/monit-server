<script setup>
import { ref, nextTick, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../stores/auth.js';
import { API_BASE } from '../base.js';

const auth = useAuth();
const router = useRouter();

// A message is { role, content, think, tools[], report, logId, feedback }
const messages = ref([]);
const input = ref('');
const streaming = ref(false);
const error = ref('');
const caps = ref(null);
const chatEnd = ref(null);
const showThink = ref({});

const modelName = computed(() => caps.value?.model || '');
const toolsOn = computed(() => caps.value?.tools !== false);

/**
 * Same JWT handling as api.js, minus the JSON parsing.
 *
 * The chat endpoint streams, so it cannot go through api.js at all — but the
 * part of api.js that matters here is the 401 retry. Access tokens last 15
 * minutes; without this, a chat tab left open over lunch answers the next
 * question with a bare "HTTP 401" while every other page in the app quietly
 * refreshes and carries on.
 */
async function authFetch(path, init = {}, retry = true) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${auth.accessToken}` },
  });
  if (res.status === 401 && retry && auth.refreshToken) {
    if (await auth.refresh()) return authFetch(path, init, false);
    auth.logout();
  }
  return res;
}

const restoring = ref(true);

onMounted(async () => {
  // Capabilities and the saved conversation are independent — no reason for
  // the transcript to wait on a badge.
  const [capsRes, histRes] = await Promise.all([
    authFetch('/api/v1/chat/capabilities').catch(() => null),
    authFetch('/api/v1/chat/history').catch(() => null),
  ]);
  try { if (capsRes?.ok) caps.value = await capsRes.json(); } catch { /* badge is optional */ }
  try {
    if (histRes?.ok) {
      const j = await histRes.json();
      if (Array.isArray(j.messages)) messages.value = j.messages;
    }
  } catch { /* an unreadable transcript should not block a new conversation */ }
  restoring.value = false;
});

/**
 * Persist the conversation after every completed turn.
 *
 * The whole rendered transcript goes up, not just role and content: the tool
 * trace, the reasoning block and the report card are what make a reopened
 * conversation look like the one that was left, and rebuilding them from
 * role/content alone is impossible. Failures are silent — losing a save is a
 * far smaller problem than an error banner over a perfectly good answer.
 */
async function saveHistory() {
  if (restoring.value) return;
  try {
    await authFetch('/api/v1/chat/history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.value }),
    });
  } catch { /* ignore */ }
}

function scrollBottom() {
  nextTick(() => chatEnd.value?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
}

const TOOL_LABEL = {
  list_servers: 'อ่านรายชื่อ server',
  get_server_detail: 'ดูรายละเอียดเครื่อง',
  query_metrics: 'ดึงกราฟย้อนหลัง',
  get_incidents: 'ดู incident',
  get_incident_history: 'ค้นประวัติเคสคล้ายกัน',
  get_ndb_topology: 'อ่านผัง NDB cluster',
  get_services: 'ตรวจ service ที่ควรรัน',
  get_alert_rules: 'ทบทวน alert rule',
  get_notification_stats: 'ตรวจการส่งแจ้งเตือน',
  correlate: 'หาความสัมพันธ์ข้ามเครื่อง',
  run_sql: 'query ฐานข้อมูล',
};
const toolLabel = (n) => TOOL_LABEL[n] || n;
const argHint = (a) => {
  if (!a || typeof a !== 'object') return '';
  const v = a.server || a.metric || a.sql || a.status || a.name_contains;
  return v ? String(v).slice(0, 60) : '';
};

async function send(preset) {
  const text = (preset ?? input.value).trim();
  if (!text || streaming.value) return;

  error.value = '';
  messages.value.push({ role: 'user', content: text });
  input.value = '';

  const msg = { role: 'assistant', content: '', think: '', tools: [], report: null, logId: null, feedback: 0, status: '' };
  messages.value.push(msg);
  streaming.value = true;
  scrollBottom();

  try {
    const res = await authFetch('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The filter already removes the empty assistant placeholder pushed a
        // few lines above — it is the only message with no content. Slicing a
        // further element off the end took the user's newest question with it,
        // which made the very first message of every conversation an empty
        // array and a 400, and every later one an answer to the previous turn.
        messages: messages.value
          .filter((m) => m.role !== 'assistant' || m.content)
          .map(({ role, content }) => ({ role, content })),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.title || j.detail || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
        let e;
        try { e = JSON.parse(data); } catch { continue; }
        switch (e.t) {
          case 'meta':
            msg.intent = e.intent;
            break;
          case 'status':
            if (e.s === 'tool') {
              msg.tools.push({ name: e.name, hint: argHint(e.args), done: false });
              msg.status = 'tool';
            } else if (e.s === 'report') {
              msg.status = 'report';
              msg.reportKind = e.label;
            } else {
              msg.status = 'answering';
            }
            scrollBottom();
            break;
          case 'tool_done': {
            const t = [...msg.tools].reverse().find((x) => x.name === e.name && !x.done);
            if (t) { t.done = true; t.chars = e.chars; }
            break;
          }
          case 'think':
            msg.think += e.c;
            break;
          case 'delta':
            msg.content += e.c;
            scrollBottom();
            break;
          case 'report':
            msg.report = { id: e.id, title: e.title, kind: e.kind };
            break;
          case 'logged':
            msg.logId = e.id;
            break;
          case 'error':
            error.value = e.m;
            break;
          default:
            break;
        }
      }
    }

    if (!msg.content && !error.value) msg.content = '(ไม่มีคำตอบกลับมา — ลองถามใหม่อีกครั้ง)';
  } catch (e) {
    error.value = e.message;
    if (!msg.content) messages.value.pop();
  } finally {
    msg.status = '';
    streaming.value = false;
    scrollBottom();
    saveHistory();
  }
}

async function rate(msg, value) {
  if (!msg.logId || msg.feedback === value) return;
  msg.feedback = value;
  saveHistory();
  try {
    await authFetch('/api/v1/chat/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: msg.logId, value }),
    });
  } catch { /* a lost rating is not worth an error banner */ }
}

async function clearChat() {
  messages.value = [];
  error.value = '';
  showThink.value = {};
  try { await authFetch('/api/v1/chat/history', { method: 'DELETE' }); } catch { /* ignore */ }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

/**
 * Small markdown renderer.
 *
 * Deliberately not a library: the model's output is escaped first and only a
 * fixed set of constructs is ever turned back into HTML, so there is no path
 * from a model token to executable markup. Tables are in because the prompt
 * asks for tables when comparing servers, and without support for them the
 * best-formatted answers were the ones that looked most broken.
 */
function renderMd(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = [];
  let src = esc(String(text));

  // Pull fenced code out first so nothing else rewrites its contents.
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0001${blocks.length - 1}\u0001`;
  });

  const lines = src.split('\n');
  const out = [];
  let list = null;      // 'ul' | 'ol'
  let table = null;     // { head: [], rows: [] }

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => {
    if (!table) return;
    out.push('<div class="md-scroll"><table><thead><tr>'
      + table.head.map((h) => `<th>${inline(h)}</th>`).join('')
      + '</tr></thead><tbody>'
      + table.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
      + '</tbody></table></div>');
    table = null;
  };

  function inline(s2) {
    return s2
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  // Table detection, deliberately forgiving.
  //
  // The strict form — every row fenced by outer pipes, a separator row directly
  // under the header — is what the prompt asks for and what the model usually
  // produces. Usually. When it drops the outer pipes, or forgets the separator,
  // the strict parser fell through to paragraph text and the user got a screen
  // of numbers glued together with "|", which is exactly the failure that looks
  // like the feature is broken. So: a line with at least two pipes starts a
  // table, a separator row is used when present and skipped when absent.
  const looksLikeRow = (l) => (l.match(/\|/g) || []).length >= 2 && !/^\|?\s*$/.test(l);
  const isSeparator = (l) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(l) && /-/.test(l);
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();

    if (!table && looksLikeRow(raw) && !isSeparator(raw)) {
      const next = (lines[i + 1] || '').trim();
      // A header needs either a separator under it or a second row to be a
      // table at all — one lone piped line is prose containing a pipe.
      if (isSeparator(next) || looksLikeRow(next)) {
        closeList();
        table = { head: cells(raw), rows: [] };
        if (isSeparator(next)) i++;
        continue;
      }
    }
    if (table) {
      if (isSeparator(raw)) continue;
      if (looksLikeRow(raw)) {
        const r = cells(raw);
        // Pad or trim to the header width so a ragged row cannot skew the grid.
        while (r.length < table.head.length) r.push('');
        table.rows.push(r.slice(0, table.head.length));
        continue;
      }
      closeTable();
    }

    if (!raw) { closeList(); continue; }

    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }

    const ul = raw.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`); continue;
    }
    const ol = raw.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`); continue;
    }
    closeList();
    if (/^\u0001\d+\u0001$/.test(raw)) { out.push(raw); continue; }
    out.push(`<p>${inline(raw)}</p>`);
  }
  closeList(); closeTable();

  return out.join('').replace(/\u0001(\d+)\u0001/g, (_, i) => blocks[Number(i)]);
}

const SUGGESTIONS = [
  'server ไหนเสี่ยงที่สุดตอนนี้ และควรทำอะไรก่อน',
  'วิเคราะห์แนวโน้ม disk 7 วัน เครื่องไหนจะเต็มก่อน',
  'ขอรายงานผัง MySQL NDB cluster',
  'ทำไม RAM ถึงขึ้นสูงผิดปกติ',
  'ทบทวน alert rule ว่ามีข้อไหน threshold ไม่เหมาะ',
];
</script>

<template>
  <div class="chat-page">
    <div class="chat-header">
      <h1>AI Assistant</h1>
      <div class="chat-header-right">
        <span v-if="modelName" class="model-tag">{{ modelName }}</span>
        <span class="model-tag" :class="toolsOn ? 'on' : 'off'" :title="toolsOn
          ? 'ผู้ช่วยเรียกข้อมูลเพิ่มเองได้'
          : 'vLLM ตัวนี้ยังไม่ได้เปิด tool calling — ตอบจากบริบทที่ส่งไปให้เท่านั้น'">
          {{ toolsOn ? 'tools on' : 'tools off' }}
        </span>
        <router-link class="sm-link" to="/reports">Reports</router-link>
        <button class="sm" @click="clearChat" :disabled="streaming"
                title="ลบบทสนทนานี้ทิ้ง — บทสนทนาจะถูกเก็บไว้จนกว่าจะกดปุ่มนี้">Clear</button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="chat-messages">
      <div v-if="restoring" class="chat-empty"><div class="chat-empty-hint">กำลังเรียกบทสนทนาเดิม…</div></div>
      <div v-else-if="!messages.length" class="chat-empty">
        <div class="chat-empty-title">ถามเรื่อง infrastructure ได้เลย</div>
        <div class="chat-empty-hint">ผู้ช่วยเห็นค่า cpu/ram/disk/load พร้อม p95 24 ชม., แนวโน้ม 7 วัน,
          incident, service ที่ควรรัน และผัง NDB cluster — และเรียกดูข้อมูลย้อนหลังเพิ่มเองได้</div>
        <div class="chat-suggestions">
          <button v-for="s in SUGGESTIONS" :key="s" class="suggestion" @click="send(s)">{{ s }}</button>
        </div>
      </div>

      <template v-for="(msg, i) in messages" :key="i">
        <div class="chat-msg" :class="msg.role">
          <div class="chat-avatar">{{ msg.role === 'user' ? 'U' : 'AI' }}</div>
          <div class="chat-col">
            <!-- what the assistant went and looked at -->
            <div v-if="msg.role === 'assistant' && msg.tools?.length" class="trace">
              <div v-for="(t, ti) in msg.tools" :key="ti" class="trace-row" :class="{ done: t.done }">
                <span class="tick">{{ t.done ? '✓' : '…' }}</span>
                <span class="tname">{{ toolLabel(t.name) }}</span>
                <span v-if="t.hint" class="thint">{{ t.hint }}</span>
              </div>
            </div>
            <div v-else-if="msg.role === 'assistant' && msg.status === 'report'" class="trace">
              <div class="trace-row"><span class="tick">…</span>
                <span class="tname">กำลังสร้างรายงาน {{ msg.reportKind }}</span></div>
            </div>

            <div class="chat-bubble">
              <div v-if="msg.role === 'assistant'">
                <div v-if="msg.think" class="think">
                  <button class="think-toggle" @click="showThink[i] = !showThink[i]">
                    {{ showThink[i] ? 'ซ่อนวิธีคิด' : 'ดูวิธีคิดของโมเดล' }}
                  </button>
                  <pre v-if="showThink[i]" class="think-body">{{ msg.think }}</pre>
                </div>
                <div v-html="renderMd(msg.content || '')" class="md-content"></div>
                <div v-if="msg.report" class="report-card" @click="router.push(`/reports/${msg.report.id}`)">
                  <div class="rc-title">{{ msg.report.title }}</div>
                  <div class="rc-sub">เปิดรายงานฉบับเต็ม →</div>
                </div>
                <div v-if="msg.logId && msg.content" class="rate">
                  <button :class="{ on: msg.feedback === 1 }" @click="rate(msg, 1)" title="ตอบดี">▲</button>
                  <button :class="{ on: msg.feedback === -1 }" @click="rate(msg, -1)" title="ตอบไม่ดี">▼</button>
                </div>
              </div>
              <div v-else class="user-text">{{ msg.content }}</div>
              <div v-if="msg.role === 'assistant' && streaming && i === messages.length - 1 && !msg.content" class="typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div ref="chatEnd"></div>
    </div>

    <div class="chat-input-area">
      <div class="chat-input-wrap">
        <textarea
          v-model="input"
          @keydown="handleKey"
          placeholder="ถามได้เลย เช่น ทำไม db-01 ถึง RAM สูง…"
          rows="1"
          :disabled="streaming"
          class="chat-input"
        ></textarea>
        <button class="send-btn" @click="send()" :disabled="!input.trim() || streaming" :class="{ active: input.trim() && !streaming }">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-page { display: flex; flex-direction: column; height: calc(100vh - 40px); max-height: calc(100vh - 40px); }
.chat-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-shrink: 0; }
.chat-header h1 { margin: 0; }
.chat-header-right { display: flex; align-items: center; gap: 8px; }
.model-tag {
  font-size: 11px; color: var(--muted); background: var(--surface);
  border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.model-tag.on { color: var(--good); border-color: color-mix(in oklab, var(--good) 40%, var(--border)); }
.model-tag.off { color: var(--warning); border-color: color-mix(in oklab, var(--warning) 40%, var(--border)); }
.sm-link { font-size: 12px; color: var(--ink-2); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; }
.sm-link:hover { text-decoration: none; color: var(--ink); border-color: var(--accent); }

.chat-messages { flex: 1; overflow-y: auto; padding: 8px 0; display: flex; flex-direction: column; gap: 16px; }

.chat-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 10px; color: var(--muted); text-align: center; }
.chat-empty-title { font-size: 18px; font-weight: 600; color: var(--ink-2); }
.chat-empty-hint { font-size: 13px; margin-bottom: 6px; max-width: 560px; line-height: 1.6; }
.chat-suggestions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 640px; }
.suggestion { font-size: 13px; padding: 8px 14px; border-radius: 20px; background: var(--surface); border: 1px solid var(--border); color: var(--ink-2); cursor: pointer; }
.suggestion:hover { border-color: var(--accent); color: var(--ink); }

.chat-msg { display: flex; gap: 12px; align-items: flex-start; max-width: 880px; }
.chat-msg.user { align-self: flex-end; flex-direction: row-reverse; }
.chat-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.chat-msg.user .chat-col { align-items: flex-end; }

.chat-avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.chat-msg.user .chat-avatar { background: color-mix(in oklab, var(--accent) 20%, transparent); color: var(--accent); }
.chat-msg.assistant .chat-avatar { background: color-mix(in oklab, var(--good) 18%, transparent); color: var(--good); }

/* what the assistant looked up before answering */
.trace { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border-left: 2px solid var(--border); }
.trace-row { display: flex; align-items: baseline; gap: 7px; font-size: 12px; color: var(--muted); }
.trace-row.done { color: var(--ink-2); }
.tick { width: 10px; font-family: ui-monospace, monospace; }
.thint { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: 0.75; }

.chat-bubble { border-radius: 14px; padding: 10px 16px; line-height: 1.6; font-size: 14px; max-width: 760px; word-break: break-word; }
.chat-msg.user .chat-bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.chat-msg.assistant .chat-bubble { background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.user-text { white-space: pre-wrap; }

.think { margin-bottom: 8px; }
.think-toggle { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; background: transparent; border: 1px dashed var(--border); color: var(--muted); cursor: pointer; }
.think-body { white-space: pre-wrap; font-size: 12px; color: var(--muted); background: var(--page); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0 0; max-height: 320px; overflow: auto; }

.report-card { margin-top: 10px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 12px; cursor: pointer; background: var(--page); }
.report-card:hover { border-color: var(--accent); }
.rc-title { font-weight: 600; font-size: 13.5px; }
.rc-sub { font-size: 12px; color: var(--accent); margin-top: 2px; }

.rate { display: flex; gap: 4px; margin-top: 8px; }
.rate button { background: transparent; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); font-size: 11px; padding: 1px 8px; cursor: pointer; }
.rate button.on { color: var(--accent); border-color: var(--accent); }

.md-content :deep(p) { margin: 0 0 8px; }
.md-content :deep(p:last-child) { margin: 0; }
.md-content :deep(h3), .md-content :deep(h4), .md-content :deep(h5), .md-content :deep(h6) { font-size: 14px; margin: 12px 0 6px; }
.md-content :deep(pre) { background: var(--page); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; overflow-x: auto; font-size: 12px; margin: 8px 0; }
.md-content :deep(code) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.md-content :deep(p code), .md-content :deep(li code), .md-content :deep(td code) { background: var(--page); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border); }
.md-content :deep(strong) { font-weight: 600; }
.md-content :deep(ul), .md-content :deep(ol) { margin: 6px 0; padding-left: 20px; }
.md-content :deep(li) { margin: 3px 0; }
.md-content :deep(.md-scroll) { overflow-x: auto; margin: 8px 0; }
.md-content :deep(table) { border-collapse: collapse; font-size: 12.5px; min-width: 100%; }
.md-content :deep(th), .md-content :deep(td) { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.md-content :deep(th) { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.md-content :deep(td) { font-variant-numeric: tabular-nums; }

.typing { display: flex; gap: 4px; padding: 4px 0; }
.typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: typingDot 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typingDot { 0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); } 30% { opacity: 1; transform: scale(1); } }

.chat-input-area { flex-shrink: 0; padding: 12px 0 4px; border-top: 1px solid var(--border); }
.chat-input-wrap { display: flex; align-items: flex-end; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 6px 8px 6px 16px; }
.chat-input-wrap:focus-within { border-color: var(--accent); }
.chat-input { flex: 1; border: none; background: transparent; color: var(--ink); font: inherit; resize: none; padding: 6px 0; line-height: 1.45; max-height: 140px; outline: none; }
.chat-input::placeholder { color: var(--muted); }
.send-btn { width: 36px; height: 36px; border-radius: 10px; border: none; background: transparent; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0; }
.send-btn.active { background: var(--accent); color: #fff; }
.send-btn:disabled { opacity: 0.4; cursor: default; }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; } }
</style>
