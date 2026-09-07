<script setup>
// Shown exactly once, right after a key is issued. Only the SHA-256 hash of a
// key is stored, so there is no screen anywhere that can show it again — this
// card is the single chance to copy it, and it says so plainly and hands over
// the command that installs it, so nobody has to transcribe by hand.
import { ref } from 'vue';

const props = defineProps({
  serverId: { type: String, required: true },
  apiKey: { type: String, required: true },
  title: { type: String, default: 'Agent key' },
});
defineEmits(['dismiss']);

const copied = ref('');
let t;

async function copy(what, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; over plain http on a LAN it is not
    // there. Fall back to a selection the user can hit Ctrl+C on.
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el); el.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    el.remove();
  }
  copied.value = what;
  clearTimeout(t);
  t = setTimeout(() => { copied.value = ''; }, 1800);
}

const applyCmd = () => `sudo /opt/monit/monit-config.sh -k ${props.apiKey}`;
</script>

<template>
  <div class="keycard">
    <div class="row" style="justify-content: space-between; align-items: baseline">
      <b>{{ title }} — {{ serverId }}</b>
      <button class="sm" @click="$emit('dismiss')">Dismiss</button>
    </div>
    <p class="warn">
      Copy it now. Keys are stored hashed, so this value cannot be displayed again —
      if it is lost, issue a new one with <b>New key</b>.
    </p>

    <div class="field">
      <code class="val">{{ apiKey }}</code>
      <button class="sm primary" @click="copy('key', apiKey)">{{ copied === 'key' ? 'Copied' : 'Copy key' }}</button>
    </div>

    <div class="field">
      <code class="val cmd">{{ applyCmd() }}</code>
      <button class="sm" @click="copy('cmd', applyCmd())">{{ copied === 'cmd' ? 'Copied' : 'Copy command' }}</button>
    </div>
    <p class="hint">
      Run that on the agent host (or set <span class="mono">MONIT_API_KEY</span> in
      <span class="mono">/etc/monit/agent.conf</span> and restart the agent).
    </p>
  </div>
</template>

<style scoped>
.keycard {
  background: var(--surface); border: 1px solid color-mix(in oklab, var(--warning) 55%, var(--border));
  border-left: 4px solid var(--warning);
  border-radius: 12px; padding: 12px 14px; margin-bottom: 12px;
}
.warn { color: var(--ink-2); font-size: 12px; margin: 6px 0 10px; }
.field { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.val {
  flex: 1; min-width: 0; user-select: all; overflow-x: auto; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--grid); border-radius: 7px; padding: 7px 9px;
}
.cmd { color: var(--ink-2); }
.hint { color: var(--muted); font-size: 11px; margin: 2px 0 0; }
</style>
