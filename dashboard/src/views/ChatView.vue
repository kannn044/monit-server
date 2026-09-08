<script setup>
import { ref, nextTick, onMounted } from 'vue';
import { useAuth } from '../stores/auth.js';
import { API_BASE } from '../base.js';

const auth = useAuth();

const messages = ref([]);       // { role: 'user'|'assistant', content: '' }
const input = ref('');
const streaming = ref(false);
const error = ref('');
const modelName = ref('');
const chatEnd = ref(null);      // scroll anchor

// Fetch available model on mount
onMounted(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/v1/chat/models`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (res.ok) {
      const j = await res.json();
      if (j.models?.[0]) modelName.value = j.models[0].id;
    }
  } catch { /* ignore — will still work */ }
});

function scrollBottom() {
  nextTick(() => chatEnd.value?.scrollIntoView({ behavior: 'smooth' }));
}

async function send() {
  const text = input.value.trim();
  if (!text || streaming.value) return;

  error.value = '';
  messages.value.push({ role: 'user', content: text });
  input.value = '';
  scrollBottom();

  // Add placeholder for assistant reply
  const assistantMsg = { role: 'assistant', content: '' };
  messages.value.push(assistantMsg);
  streaming.value = true;
  scrollBottom();

  try {
    const res = await fetch(`${API_BASE}/api/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
      },
      body: JSON.stringify({
        messages: messages.value
          .filter((m) => m.role !== 'assistant' || m.content)
          .slice(0, -1) // exclude the empty placeholder
          .map(({ role, content }) => ({ role, content })),
      }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.title || j.detail || `HTTP ${res.status}`);
    }

    // Parse SSE stream
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
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            assistantMsg.content += delta;
            scrollBottom();
          }
        } catch { /* skip malformed chunks */ }
      }
    }

    // Strip <think>...</think> blocks from the final content
    assistantMsg.content = assistantMsg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (!assistantMsg.content) {
      assistantMsg.content = '(no response)';
    }
  } catch (e) {
    error.value = e.message;
    // Remove the empty assistant placeholder on error
    if (!assistantMsg.content) messages.value.pop();
  } finally {
    streaming.value = false;
    scrollBottom();
  }
}

function clearChat() {
  messages.value = [];
  error.value = '';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// Simple markdown-ish rendering: code blocks, inline code, bold, lists
function renderMd(text) {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Bullet lists
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newlines
    .replace(/\n/g, '<br>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*?<\/li>(?:<br>)?)+)/g, '<ul>$1</ul>');
  return `<p>${html}</p>`;
}
</script>

<template>
  <div class="chat-page">
    <div class="chat-header">
      <h1>AI Assistant</h1>
      <div class="chat-header-right">
        <span v-if="modelName" class="model-tag">{{ modelName }}</span>
        <button class="sm" @click="clearChat" :disabled="streaming">Clear</button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="chat-messages">
      <div v-if="!messages.length" class="chat-empty">
        <div class="chat-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="chat-empty-title">Ask about your infrastructure</div>
        <div class="chat-empty-hint">
          Try asking things like:
        </div>
        <div class="chat-suggestions">
          <button class="suggestion" @click="input = 'server ทั้งหมดมี PM2 service กี่ตัว'; send()">PM2 services ทั้งหมดมีกี่ตัว?</button>
          <button class="suggestion" @click="input = 'server ไหนมีปัญหาบ้าง'; send()">server ไหนมีปัญหา?</button>
          <button class="suggestion" @click="input = 'สรุป incident ที่ยังเปิดอยู่'; send()">สรุป incident ที่เปิดอยู่</button>
          <button class="suggestion" @click="input = 'List all Docker containers across servers'; send()">List all Docker containers</button>
        </div>
      </div>

      <template v-for="(msg, i) in messages" :key="i">
        <div class="chat-msg" :class="msg.role">
          <div class="chat-avatar">{{ msg.role === 'user' ? 'U' : 'AI' }}</div>
          <div class="chat-bubble">
            <div v-if="msg.role === 'assistant'" v-html="renderMd(msg.content || '')" class="md-content"></div>
            <div v-else class="user-text">{{ msg.content }}</div>
            <div v-if="msg.role === 'assistant' && streaming && i === messages.length - 1 && !msg.content" class="typing">
              <span></span><span></span><span></span>
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
          placeholder="Ask about your servers..."
          rows="1"
          :disabled="streaming"
          class="chat-input"
        ></textarea>
        <button class="send-btn" @click="send" :disabled="!input.trim() || streaming" :class="{ active: input.trim() && !streaming }">
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
.chat-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 40px);
  max-height: calc(100vh - 40px);
}
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.chat-header h1 { margin: 0; }
.chat-header-right { display: flex; align-items: center; gap: 10px; }
.model-tag {
  font-size: 11px;
  color: var(--muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Messages area */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Empty state */
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 10px;
  color: var(--muted);
}
.chat-empty-icon { opacity: 0.3; }
.chat-empty-title { font-size: 18px; font-weight: 600; color: var(--ink-2); }
.chat-empty-hint { font-size: 13px; margin-bottom: 6px; }
.chat-suggestions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 600px; }
.suggestion {
  font-size: 13px;
  padding: 8px 14px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.suggestion:hover { border-color: var(--accent); color: var(--ink); }

/* Message rows */
.chat-msg {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  max-width: 840px;
}
.chat-msg.user { align-self: flex-end; flex-direction: row-reverse; }

.chat-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}
.chat-msg.user .chat-avatar {
  background: color-mix(in oklab, var(--accent) 20%, transparent);
  color: var(--accent);
}
.chat-msg.assistant .chat-avatar {
  background: color-mix(in oklab, var(--good) 18%, transparent);
  color: var(--good);
}

.chat-bubble {
  border-radius: 14px;
  padding: 10px 16px;
  line-height: 1.55;
  font-size: 14px;
  max-width: 720px;
  word-break: break-word;
}
.chat-msg.user .chat-bubble {
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.chat-msg.assistant .chat-bubble {
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}
.user-text { white-space: pre-wrap; }

/* Markdown content inside assistant bubbles */
.md-content :deep(p) { margin: 0 0 8px; }
.md-content :deep(p:last-child) { margin: 0; }
.md-content :deep(pre) {
  background: var(--page);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  overflow-x: auto;
  font-size: 12px;
  margin: 8px 0;
}
.md-content :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.md-content :deep(p code) {
  background: var(--page);
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border);
}
.md-content :deep(strong) { font-weight: 600; }
.md-content :deep(ul) { margin: 6px 0; padding-left: 20px; }
.md-content :deep(li) { margin: 2px 0; }

/* Typing indicator */
.typing { display: flex; gap: 4px; padding: 4px 0; }
.typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--muted);
  animation: typingDot 1.2s infinite;
}
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typingDot {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}

/* Input area */
.chat-input-area {
  flex-shrink: 0;
  padding: 12px 0 4px;
  border-top: 1px solid var(--border);
}
.chat-input-wrap {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 6px 8px 6px 16px;
  transition: border-color 0.15s;
}
.chat-input-wrap:focus-within { border-color: var(--accent); }
.chat-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  resize: none;
  padding: 6px 0;
  line-height: 1.45;
  max-height: 140px;
  outline: none;
}
.chat-input::placeholder { color: var(--muted); }
.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.send-btn.active { background: var(--accent); color: #fff; }
.send-btn:disabled { opacity: 0.4; cursor: default; }
</style>
