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

export async function deliver(channel, payload) {
  const cfg = channel.config || {};
  switch (channel.type) {
    case 'telegram': {
      if (!cfg.bot_token || !cfg.chat_id) throw new Error('telegram channel needs config.bot_token and config.chat_id');
      return post(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
        chat_id: cfg.chat_id,
        text: renderText(payload),
        disable_web_page_preview: true,
      });
    }
    case 'slack': {
      if (!cfg.webhook_url) throw new Error('slack channel needs config.webhook_url');
      return post(cfg.webhook_url, { text: renderText(payload) });
    }
    case 'webhook': {
      if (!cfg.url) throw new Error('webhook channel needs config.url');
      return post(cfg.url, payload, cfg.headers || {});
    }
    default:
      throw new Error(`unknown channel type ${channel.type}`);
  }
}
