// Delivery implementations for each notification channel type.
// Uses global fetch (Node 20+). Every call has a hard timeout.

const TIMEOUT_MS = 10_000;

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, body: text.slice(0, 500) };
}

const SEV_EMOJI = { critical: '🔴', warning: '🟡', info: '🔵' };

function renderText(p) {
  const head = p.event === 'alert.resolved' ? '✅ RESOLVED'
    : p.event === 'alert.flapping' ? '🌀 FLAPPING (suppressed)'
    : p.event === 'alert.reminder' ? '⏰ STILL FIRING'
    : `${SEV_EMOJI[p.severity] || ''} ${String(p.severity || '').toUpperCase()}`;
  const lines = [
    `${head} — ${p.rule_name || p.rule_id || 'alert'}`,
    p.message || '',
    `server: ${p.server_id}${p.project ? `  ·  project: ${p.project} (${p.environment || '-'})` : ''}`,
  ];
  if (p.metric) lines.push(`metric: ${p.metric} = ${p.value ?? '-'} (threshold ${p.comparator || ''} ${p.threshold ?? '-'})`);
  if (p.started_at) lines.push(`since: ${p.started_at}`);
  return lines.filter(Boolean).join('\n');
}

// Credentials get pasted into a web form, and a copied token routinely carries a
// trailing space or an invisible character. Whitespace is never part of any of
// these values, so strip it rather than sending a URL Telegram cannot parse.
const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, '').trim() : v);

export async function deliver(channel, payload) {
  const cfg = channel.config || {};
  switch (channel.type) {
    case 'telegram': {
      // The URL already supplies the "bot" prefix; people paste it in anyway.
      const token = clean(cfg.bot_token).replace(/^bot(?=\d)/i, '');
      const chatId = clean(cfg.chat_id);
      if (!token || !chatId) throw new Error('telegram channel needs config.bot_token and config.chat_id');
      // Telegram answers 404 (not 401) for a token it cannot parse, which reads
      // as "the API is down" rather than "your token is wrong". Say it plainly.
      if (!/^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(token)) {
        throw new Error(
          `telegram bot_token is malformed (${token.length} chars) — expected 1234567890:AAH9xQ…; ` +
          're-copy it from @BotFather (/mybots → API Token)');
      }
      return post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: renderText(payload),
        disable_web_page_preview: true,
      });
    }
    case 'slack': {
      const url = clean(cfg.webhook_url);
      if (!url) throw new Error('slack channel needs config.webhook_url');
      return post(url, { text: renderText(payload) });
    }
    case 'webhook': {
      const url = clean(cfg.url);
      if (!url) throw new Error('webhook channel needs config.url');
      return post(url, payload, cfg.headers || {});
    }
    default:
      throw new Error(`unknown channel type ${channel.type}`);
  }
}
