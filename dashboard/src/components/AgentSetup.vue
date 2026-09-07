<script setup>
// Shown once, immediately after a server is registered.
//
// The old card printed `monit-config.sh -k <key>`, which changes the key on an
// agent that is *already installed* — useless on a machine that has none yet.
// What someone needs at this moment is the deploy command, filled in with the
// two values only this screen knows: the server id and the key that is visible
// exactly once.
//
// The steps are numbered because this genuinely is a sequence — you cannot run
// the deploy script before you are on the central server as root.
import { ref, computed } from 'vue';

const props = defineProps({
  serverId: { type: String, required: true },
  apiKey: { type: String, required: true },
  serverIp: { type: String, default: '' },
  agentUrl: { type: String, default: '' },      // where agents reach this server
  deployDir: { type: String, default: '/home/gdata/monit-server' },
  title: { type: String, default: 'Server registered' },
  rotated: { type: Boolean, default: false },   // key replaced on an existing host
});
defineEmits(['dismiss']);

// The SSH login differs per machine and the dashboard has no way to know it, so
// it is asked for here and remembered for the next server — it is almost always
// the same account across a fleet.
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
const ready = computed(() => !!sshHost.value.trim() && !!props.agentUrl);

const deployCmd = computed(() =>
  `./deploy-agent.sh ${target.value} -i ${props.serverId} -k ${props.apiKey} -U ${props.agentUrl || '<central-server-url>'}`);

// A real multi-line string rather than <br>: the block is white-space: pre, and
// this way Copy produces something that can be pasted straight into a shell.
const loginCmd = computed(() => `ssh <central-server>\nsudo -i\ncd ${props.deployDir}`);

const rotateCmd = computed(() =>
  `ssh -t ${target.value} 'sudo /opt/monit/monit-config.sh -k ${props.apiKey}'`);

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
            <b class="mono">{{ serverId }}</b> is registered. It stays offline until the agent is
            installed on the machine — two commands below.
          </template>
        </p>
      </div>
      <button class="sm" @click="$emit('dismiss')">Done</button>
    </header>

    <!-- The key is the one thing on this page that cannot be recovered, so it
         leads and says so. -->
    <div class="keyrow">
      <div class="klabel">
        Agent key
        <span class="once">shown once</span>
      </div>
      <code class="kval">{{ apiKey }}</code>
      <button class="sm primary" @click="copy('key', apiKey)">{{ copied === 'key' ? 'Copied' : 'Copy' }}</button>
    </div>
    <p class="note">
      Keys are stored hashed — nobody, including an admin, can read this again.
      If it is lost, an admin issues a replacement with <b>New key</b>.
    </p>

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
      </li>

      <li v-if="!rotated">
        <div class="what">Push the agent to <b class="mono">{{ serverId }}</b></div>
        <div class="cmdrow">
          <code>{{ deployCmd }}</code>
          <button class="sm primary" :disabled="!ready" @click="copy('deploy', deployCmd)">
            {{ copied === 'deploy' ? 'Copied' : 'Copy' }}
          </button>
        </div>
        <ul class="legend">
          <li><code>{{ target }}</code> the machine being monitored — you fill this in above</li>
          <li><code>-i {{ serverId }}</code> the ID you just registered, from this page</li>
          <li><code>-k sk_agent_…</code> the key above, from this page</li>
          <li>
            <code>-U {{ agentUrl || '(not set)' }}</code>
            <template v-if="agentUrl"> where agents reach this server — set once in Settings</template>
            <template v-else>
              <b class="warn">not configured</b> — an admin sets it in Settings → “Address agents connect to”.
              It is not the address of this dashboard.
            </template>
          </li>
        </ul>
      </li>

      <li v-else>
        <div class="what">Install the new key on <b class="mono">{{ serverId }}</b></div>
        <div class="cmdrow">
          <code>{{ rotateCmd }}</code>
          <button class="sm primary" :disabled="!sshHost" @click="copy('rot', rotateCmd)">
            {{ copied === 'rot' ? 'Copied' : 'Copy' }}
          </button>
        </div>
        <ul class="legend">
          <li><code>-t</code> keeps the terminal attached so <code>sudo</code> can ask for a password</li>
        </ul>
      </li>

      <li>
        <div class="what">Check it arrived</div>
        <div class="plain">
          The script sends one real sample before it enables anything, so it tells you
          straight away if the URL or key is wrong. Within about 30&nbsp;seconds
          <b class="mono">{{ serverId }}</b> turns <b class="ok">online</b> on the Fleet page.
        </div>
      </li>
    </ol>
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

.keyrow { display: flex; align-items: center; gap: 10px; margin: 12px 0 4px; flex-wrap: wrap; }
.klabel { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
.once {
  display: inline-block; margin-left: 6px; text-transform: none; letter-spacing: 0;
  color: var(--warning); font-weight: 700;
}
.kval {
  flex: 1; min-width: 260px; user-select: all; overflow-x: auto; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--grid); border-radius: 7px; padding: 8px 10px;
}
.note { font-size: 11px; color: var(--muted); margin: 0 0 12px; }

.ask { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 4px; }
.ask .f { flex: 1; min-width: 170px; }
.hint { flex-basis: 100%; font-size: 11px; color: var(--muted); margin: 0; }

.steps { margin: 12px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 14px; }
.steps > li::marker { color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 700; }
.what { font-size: 13px; font-weight: 600; margin-bottom: 5px; }
.plain { font-size: 12px; color: var(--ink-2); max-width: 72ch; line-height: 1.55; }

.cmdrow { display: flex; gap: 8px; align-items: stretch; }
.cmdrow code {
  /* pre-wrap, not pre: the deploy line is long, and a soft wrap shows all of it
     without a sideways scroll. Soft wraps put no newline on the clipboard, so a
     manual select-and-copy still pastes as one command. */
  flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--grid); border-radius: 7px; padding: 8px 10px; line-height: 1.6;
}
.cmdrow button { align-self: flex-start; }

.legend { margin: 7px 0 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.legend li { font-size: 11px; color: var(--muted); line-height: 1.55; }
.legend code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink-2); margin-right: 6px;
}
.warn { color: var(--warning); }
.ok { color: var(--good); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
