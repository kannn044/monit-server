<script setup>
// Shown once, immediately after a server is registered.
//
// Two ways in, and they are not equal, so the panel does not present them as a
// choice between peers:
//
//   1. One line pasted on the machine being monitored. Whoever is installing is
//      already logged in there with root — no account on the central server, no
//      ssh hop, and the agent key never passes through their hands.
//   2. deploy-agent.sh over ssh from the central server. Still the right tool
//      for a batch of hosts, and the fallback when the target cannot reach the
//      dashboard's own URL. It needs an account on the central server, so it is
//      tucked away rather than offered first.
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  serverId: { type: String, required: true },
  // Empty when the panel was opened just to get an install link: the key exists
  // but has never been in this browser, and it cannot be read back.
  apiKey: { type: String, default: '' },
  serverIp: { type: String, default: '' },
  agentUrl: { type: String, default: '' },      // where agents reach this server
  deployDir: { type: String, default: '/home/gdata/monit-server' },
  title: { type: String, default: 'Server registered' },
  rotated: { type: Boolean, default: false },   // key replaced on an existing host
  install: { type: Object, default: null },     // { token, expires_at } from the API
});
defineEmits(['dismiss']);

// ---- the one-line install ---------------------------------------------------
const token = ref(props.install?.token || '');
const expiresAt = ref(props.install?.expires_at ? new Date(props.install.expires_at) : null);
const minting = ref(false);
const mintError = ref('');
const now = ref(Date.now());

const timer = setInterval(() => { now.value = Date.now(); }, 1000);
onBeforeUnmount(() => clearInterval(timer));

watch(() => props.install, (v) => {
  token.value = v?.token || '';
  expiresAt.value = v?.expires_at ? new Date(v.expires_at) : null;
  serverCmd.value = v?.command || '';
  if (v?.base_url) { baseUrl.value = v.base_url; baseSource.value = v.base_url_source || 'setting'; }
  urlOk.value = v?.base_url_ok ?? null;
  urlCertain.value = v?.base_url_certain ?? true;
  urlDetail.value = v?.base_url_detail || '';
});

const secondsLeft = computed(() => {
  if (!expiresAt.value) return null;
  return Math.max(0, Math.floor((expiresAt.value.getTime() - now.value) / 1000));
});
const expired = computed(() => secondsLeft.value !== null && secondsLeft.value === 0);
const countdown = computed(() => {
  const s = secondsLeft.value;
  if (s === null) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

// The server works out the base URL and hands back the finished command. It is
// in a better position to: it knows the configured setting AND, when there is
// none, the address this request actually arrived on — which is a guess that
// demonstrably reaches the server. Recomposing the command here from a setting
// that may be blank is what produced a dead <central-server-url> placeholder and
// a Copy button nobody could press.
const serverCmd = ref(props.install?.command || '');
const baseUrl = ref(props.install?.base_url || props.agentUrl || '');
const baseSource = ref(props.install?.base_url_source || (props.agentUrl ? 'setting' : 'none'));

// The server tries the address before handing it over. `urlBroken` means it got
// a definite answer that this is not the API — a link built on it cannot work,
// so say so instead of letting someone find out as a bash syntax error.
const urlOk = ref(props.install?.base_url_ok ?? null);
const urlCertain = ref(props.install?.base_url_certain ?? true);
const urlDetail = ref(props.install?.base_url_detail || '');

const base = computed(() => (baseUrl.value || '').replace(/\/+$/, ''));
const guessed = computed(() => baseSource.value === 'request');
const urlBroken = computed(() => urlOk.value === false && urlCertain.value === true);
const urlUnverified = computed(() => urlOk.value === false && urlCertain.value === false);
const installCmd = computed(() =>
  serverCmd.value || `sudo bash -c 'curl -sSL ${base.value || '<central-server-url>'}/install/${token.value} | bash'`);

async function newLink() {
  minting.value = true;
  mintError.value = '';
  try {
    const r = await api(`/api/v1/servers/${props.serverId}/install-token`, { method: 'POST' });
    token.value = r.token;
    expiresAt.value = new Date(r.expires_at);
    serverCmd.value = r.command || '';
    baseUrl.value = r.base_url || baseUrl.value;
    baseSource.value = r.base_url_source || baseSource.value;
    urlOk.value = r.base_url_ok ?? null;
    urlCertain.value = r.base_url_certain ?? true;
    urlDetail.value = r.base_url_detail || '';
  } catch (e) {
    mintError.value = e.message;
  } finally {
    minting.value = false;
  }
}

// ---- the ssh route ----------------------------------------------------------
const sshOpen = ref(false);
const sshUser = ref(readPref('monit.deploy.sshuser', ''));
const sshHost = ref(props.serverIp || '');

function readPref(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function remember() { try { localStorage.setItem('monit.deploy.sshuser', sshUser.value); } catch { /* ignore */ } }

const target = computed(() => {
  const u = sshUser.value.trim();
  const h = sshHost.value.trim();
  if (u && h) return `${u}@${h}`;
  if (h) return h;
  return '<user>@<server-ip>';
});

const deployCmd = computed(() =>
  `./deploy-agent.sh ${target.value} -i ${props.serverId} -k ${props.apiKey} -U ${props.agentUrl || '<central-server-url>'}`);

// A real multi-line string rather than <br>: the block is pre-wrapped, and this
// way Copy produces something that can be pasted straight into a shell.
const loginCmd = computed(() => `ssh <central-server>\nsudo -i\ncd ${props.deployDir}`);

const rotateCmd = computed(() =>
  `ssh -t ${target.value} 'sudo /opt/monit/monit-config.sh -k ${props.apiKey}'`);

const keyOpen = ref(false);

const copied = ref('');
let t;
async function copy(what, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API needs a secure context; over plain http on a LAN it is
    // absent. Fall back to a selection the user can press Ctrl+C on.
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el); el.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    el.remove();
  }
  copied.value = what;
  clearTimeout(t);
  t = setTimeout(() => { copied.value = ''; }, 1800);
}
</script>

<template>
  <section class="setup">
    <header class="head">
      <div>
        <h2>{{ title }}</h2>
        <p class="sub">
          <template v-if="rotated">
            The old key stopped working just now. Install this one on
            <b class="mono">{{ serverId }}</b> or it will stay offline.
          </template>
          <template v-else>
            <b class="mono">{{ serverId }}</b> is registered. It stays offline until the agent runs
            on the machine itself.
          </template>
        </p>
      </div>
      <button class="sm" @click="$emit('dismiss')">Done</button>
    </header>

    <!-- Primary path. Everything needed is in this one line, including the key,
         so there is nothing for the person installing to carry or look up. -->
    <div class="oneline">
      <div class="ptitle">
        <span class="step">On the machine you want to monitor</span>
        <span v-if="expired" class="badge warn">link expired</span>
        <span v-else-if="secondsLeft !== null" class="badge">
          works once · expires in <b class="tnum">{{ countdown }}</b>
        </span>
        <span v-if="urlBroken" class="badge bad">wrong address — this will not work</span>
        <span v-else-if="guessed" class="badge warn">address not confirmed</span>
      </div>

      <div class="cmdrow">
        <code :class="{ stale: expired || !token }">{{ token ? installCmd : '— no install link —' }}</code>
        <!-- Never disabled while there is a link. A greyed-out Copy is a dead
             end: whatever is wrong, the person still wants the text. -->
        <button v-if="!expired && token" class="sm primary" @click="copy('one', installCmd)">
          {{ copied === 'one' ? 'Copied' : 'Copy' }}
        </button>
        <button v-else class="sm primary" :disabled="minting" @click="newLink">
          {{ minting ? 'Creating…' : 'New link' }}
        </button>
      </div>

      <p v-if="expired || !token" class="phint">
        Install links are short-lived on purpose. A new one issues a new agent key, so any agent
        still using the old one stops reporting.
      </p>
      <p v-else class="phint">
        Run it on <b class="mono">{{ serverIp || serverId }}</b>, signed in as any account with
        <code>sudo</code> there.
      </p>
      <ul v-if="!expired && token" class="facts">
        <li>
          <b>The password it asks for is that machine's own login password</b> — the account you
          are signed in as. Nothing from this dashboard: not your dashboard password, not the
          agent key.
        </li>
        <li>
          Getting it wrong costs nothing. <code>sudo</code> authenticates before the link is
          fetched, so the link survives a mistyped password — just run it again.
        </li>
        <li>
          The script sends one real sample before enabling anything, so a wrong address or key
          fails there and then, in front of you.
        </li>
      </ul>

      <p v-if="urlBroken" class="phint bad">
        {{ urlDetail }}
        An admin fixes it in Settings → “Address agents connect to”, then press
        <b>New link</b> here.
      </p>
      <p v-else-if="urlUnverified" class="phint warn">
        {{ urlDetail }}
      </p>
      <p v-else-if="guessed" class="phint warn">
        <b>{{ base }}</b> is where you are reading this dashboard from, not a configured value —
        the agent has to reach the API at that address for the install to work. An admin sets the
        real one once in Settings → “Address agents connect to”; it is usually the app's own IP and
        port, e.g. <code>http://10.1.1.171:8080</code>.
      </p>
      <p v-else-if="!base" class="phint warn">
        There is no address for the agent to post to. An admin sets it in
        Settings → “Address agents connect to” — the IP and port the app listens on,
        e.g. <code>http://10.1.1.171:8080</code>.
      </p>
      <p v-if="mintError" class="phint warn">{{ mintError }}</p>
    </div>

    <!-- Secondary path. Real, but it needs an account on the central server, so
         it does not compete for attention with the line above. -->
    <details v-if="apiKey" class="alt" :open="sshOpen" @toggle="sshOpen = $event.target.open">
      <summary>
        Or push it from the central server over ssh
        <span class="muted">— for several hosts at once, or when the target cannot reach the dashboard</span>
      </summary>

      <div class="ask">
        <label class="f">
          SSH login on the target machine
          <input v-model="sshUser" placeholder="adminmop" spellcheck="false" @change="remember" />
        </label>
        <label class="f">
          Its IP or hostname
          <input v-model="sshHost" placeholder="10.1.0.222" spellcheck="false" />
        </label>
        <p class="hint">Used only to build the command below — nothing is stored on the server.</p>
      </div>

      <ol class="steps">
        <li>
          <div class="what">Open the central server and become root</div>
          <div class="cmdrow">
            <code>{{ loginCmd }}</code>
            <button class="sm" @click="copy('ssh', loginCmd)">
              {{ copied === 'ssh' ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <ul class="legend">
            <li>
              Root is not actually required — any account that can read
              <code>{{ deployDir }}</code> and ssh to the target will do. See docs/AGENTS.md.
            </li>
          </ul>
        </li>

        <li v-if="!rotated">
          <div class="what">Push the agent to <b class="mono">{{ serverId }}</b></div>
          <div class="cmdrow">
            <code>{{ deployCmd }}</code>
            <button class="sm" :disabled="!sshHost.trim()" @click="copy('deploy', deployCmd)">
              {{ copied === 'deploy' ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <ul class="legend">
            <li><code>{{ target }}</code> the machine being monitored — you fill this in above</li>
            <li><code>-i {{ serverId }}</code> the ID you just registered, from this page</li>
            <li><code>-k sk_agent_…</code> the key below, from this page</li>
            <li>
              <code>-U {{ agentUrl || '(not set)' }}</code>
              <template v-if="agentUrl"> where agents reach this server — set once in Settings</template>
              <template v-else>
                <b class="warn">not configured</b> — an admin sets it in Settings → “Address agents connect to”.
              </template>
            </li>
          </ul>
        </li>

        <li v-else>
          <div class="what">Install the new key on <b class="mono">{{ serverId }}</b></div>
          <div class="cmdrow">
            <code>{{ rotateCmd }}</code>
            <button class="sm" :disabled="!sshHost.trim()" @click="copy('rot', rotateCmd)">
              {{ copied === 'rot' ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <ul class="legend">
            <li><code>-t</code> keeps the terminal attached so <code>sudo</code> can ask for a password</li>
          </ul>
        </li>
      </ol>
    </details>

    <!-- The key is no longer something anyone has to handle, but it is still
         shown once and unrecoverable, so it stays available — just not first. -->
    <details v-if="apiKey" class="alt" :open="keyOpen" @toggle="keyOpen = $event.target.open">
      <summary>
        Show the agent key
        <span class="muted">— only needed for the ssh route or a manual install</span>
      </summary>
      <div class="keyrow">
        <code class="kval">{{ apiKey }}</code>
        <button class="sm" @click="copy('key', apiKey)">{{ copied === 'key' ? 'Copied' : 'Copy' }}</button>
      </div>
      <p class="note">
        Shown once. Keys are stored hashed — nobody, including an admin, can read this again.
        If it is lost, issue a replacement with <b>New key</b> or a fresh install link.
      </p>
    </details>

    <p class="tail">
      Within about 30&nbsp;seconds of a successful install, <b class="mono">{{ serverId }}</b>
      turns <b class="ok">online</b> on the Fleet page.
    </p>
  </section>
</template>

<style scoped>
/* Uses the app's own tokens throughout — this is a panel inside the product,
   not a place for a second visual language. */
.setup {
  background: var(--surface);
  border: 1px solid color-mix(in oklab, var(--accent) 32%, var(--border));
  border-left: 3px solid var(--accent);
  border-radius: 12px; padding: 14px 16px 16px; margin-bottom: 14px;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.head h2 { margin: 0 0 2px; font-size: 15px; }
.sub { margin: 0; font-size: 13px; color: var(--ink-2); max-width: 70ch; }

/* The one thing on this panel that most people will use gets the only filled
   surface, so the eye lands there before anything else. */
.oneline {
  margin: 12px 0 10px; padding: 12px; border-radius: 10px;
  background: color-mix(in oklab, var(--accent) 7%, var(--surface));
  border: 1px solid color-mix(in oklab, var(--accent) 22%, var(--border));
}
.ptitle { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 7px; }
.step { font-size: 13px; font-weight: 600; }
.badge {
  font-size: 11px; color: var(--muted); background: var(--grid);
  border-radius: 999px; padding: 2px 8px; white-space: nowrap;
}
.badge.warn { color: var(--warning); background: color-mix(in oklab, var(--warning) 14%, transparent); }
.badge.bad { color: var(--critical); background: color-mix(in oklab, var(--critical) 14%, transparent); font-weight: 700; }
.phint.bad { color: var(--critical); }
.tnum { font-variant-numeric: tabular-nums; }
.phint { font-size: 12px; color: var(--ink-2); margin: 8px 0 0; max-width: 78ch; line-height: 1.55; }
/* Three separate things someone needs to know, not one paragraph to wade
   through — the password question is the one that stops people. */
.facts { margin: 7px 0 0; padding-left: 16px; max-width: 78ch; }
.facts li { font-size: 12px; color: var(--ink-2); line-height: 1.55; margin-bottom: 4px; }
.facts li::marker { color: var(--muted); }
.facts code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--grid); border-radius: 4px; padding: 0 4px;
}
.phint.warn { color: var(--warning); }
.phint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.cmdrow { display: flex; gap: 8px; align-items: stretch; }
.cmdrow code {
  /* pre-wrap, not pre: these lines are long, and a soft wrap shows all of one
     without a sideways scroll. Soft wraps put no newline on the clipboard, so a
     manual select-and-copy still pastes as one command. */
  flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--grid); border-radius: 7px; padding: 8px 10px; line-height: 1.6;
}
.cmdrow code.stale { color: var(--muted); text-decoration: line-through; }
.cmdrow button { align-self: flex-start; }

.link {
  background: none; border: 0; padding: 0; font: inherit; color: var(--accent);
  cursor: pointer; text-decoration: underline;
}
.link:disabled { color: var(--muted); cursor: default; }

.alt { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.alt > summary { font-size: 12px; cursor: pointer; color: var(--ink-2); }
.alt > summary::marker { color: var(--muted); }
.muted { color: var(--muted); }

.ask { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin: 10px 0 4px; }
.ask .f { flex: 1; min-width: 170px; }
.hint { flex-basis: 100%; font-size: 11px; color: var(--muted); margin: 0; }

.steps { margin: 10px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 12px; }
.steps > li::marker { color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 700; }
.what { font-size: 13px; font-weight: 600; margin-bottom: 5px; }

.legend { margin: 7px 0 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.legend li { font-size: 11px; color: var(--muted); line-height: 1.55; }
.legend code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink-2); margin-right: 6px;
}

.keyrow { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; flex-wrap: wrap; }
.kval {
  flex: 1; min-width: 260px; user-select: all; overflow-x: auto; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--grid); border-radius: 7px; padding: 8px 10px;
}
.note { font-size: 11px; color: var(--muted); margin: 0; max-width: 78ch; line-height: 1.55; }

.tail { font-size: 12px; color: var(--ink-2); margin: 12px 0 0; }
.warn { color: var(--warning); }
.ok { color: var(--good); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
