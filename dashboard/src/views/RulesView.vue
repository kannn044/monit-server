<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';
import { useAuth } from '../stores/auth.js';
import { METRICS, toDisplay, fromDisplay, conditionText, unitSuffix } from '../metrics-catalog.js';
import RulePacks from '../components/RulePacks.vue';

const auth = useAuth();
const rules = ref([]);
const channels = ref([]);
const projects = ref([]);
const servers = ref([]);
const error = ref('');
const editing = ref(null);
const tab = ref('rules'); // rules | packs
const manualRules = computed(() => rules.value.filter((r) => !r.pack_binding_id));
const packRules = computed(() => rules.value.filter((r) => r.pack_binding_id));

// Rules that fire but notify nobody — the most common "alerts do not arrive"
// cause, and nothing else on screen makes it visible.
const silentRules = computed(() => rules.value.filter((r) => r.enabled && !(r.channels || []).length));


const blank = () => ({
  name: '', metric: 'cpu.total', comparator: '>', threshold: 90, duration_min: 5,
  recover_threshold: null, severity: 'warning', scope_type: 'all', scope_ids: [],
  channels: [], enabled: true, flap_limit: 5, flap_window_min: 30,
});

async function load() {
  try {
    const [r, c, p, s] = await Promise.all([
      api('/api/v1/alert-rules'), api('/api/v1/channels'), api('/api/v1/projects'), api('/api/v1/servers'),
    ]);
    rules.value = r.rules; channels.value = c.channels; projects.value = p.projects; servers.value = s.servers;
    error.value = '';
  } catch (e) { error.value = e.message; }
}
onMounted(load);

function edit(r) {
  editing.value = r
    ? {
      ...r, channels: [...(r.channels || [])], scope_ids: [...(r.scope_ids || [])],
      threshold: toDisplay(r.metric, r.threshold), recover_threshold: toDisplay(r.metric, r.recover_threshold),
    }
    : blank();
}

async function save() {
  const r = editing.value;
  const body = {
    name: r.name, metric: r.metric, comparator: r.comparator,
    threshold: fromDisplay(r.metric, r.threshold),
    duration_min: Number(r.duration_min) || 0,
    recover_threshold: fromDisplay(r.metric, r.recover_threshold),
    severity: r.severity, scope_type: r.scope_type, scope_ids: r.scope_ids,
    channels: r.channels, enabled: r.enabled,
    flap_limit: Number(r.flap_limit) || 5, flap_window_min: Number(r.flap_window_min) || 30,
  };
  try {
    if (r.id) await api(`/api/v1/alert-rules/${r.id}`, { method: 'PUT', body });
    else await api('/api/v1/alert-rules', { method: 'POST', body });
    editing.value = null;
    await load();
  } catch (e) { error.value = e.message; }
}

async function del(r) {
  if (!confirm(`Delete rule "${r.name}"?`)) return;
  await api(`/api/v1/alert-rules/${r.id}`, { method: 'DELETE' });
  await load();
}

async function toggle(r) {
  await api(`/api/v1/alert-rules/${r.id}`, { method: 'PUT', body: { ...r, enabled: !r.enabled } });
  await load();
}
</script>

<template>
  <div class="row" style="justify-content: space-between">
    <h1>Alert rules</h1>
    <div class="row">
      <div class="seg">
        <button :class="{ on: tab === 'rules' }" @click="tab = 'rules'">Rules</button>
        <button :class="{ on: tab === 'packs' }" @click="tab = 'packs'">Rule packs (groups)</button>
      </div>
      <button v-if="auth.isAdmin && tab === 'rules'" class="primary" @click="edit(null)">New rule</button>
    </div>
  </div>
  <div v-if="error" class="error-banner">{{ error }}</div>
  <div v-if="silentRules.length" class="notice">
    {{ silentRules.length }} of {{ rules.length }} rules have no notification channel — they will open
    incidents in the dashboard but send nothing.
    <span v-if="!channels.length"> Add a channel in <router-link to="/settings">Settings</router-link> first.</span>
  </div>

  <RulePacks v-if="tab === 'packs'" :channels="channels" :projects="projects" :servers="servers" @changed="load" />

  <div v-if="tab === 'rules'" class="card">
    <table>
      <thead><tr>
        <th>Name</th><th>Condition</th><th>For</th><th>Severity</th><th>Scope</th><th>Channels</th><th>Enabled</th><th></th>
      </tr></thead>
      <tbody>
        <tr v-for="r in [...manualRules, ...packRules]" :key="r.id">
          <td>
            <b>{{ r.name }}</b>
            <span v-if="r.pack_binding_id" class="packtag" title="Managed by a rule pack — edit it in the Rule packs tab">pack: {{ r.pack_name }}</span>
          </td>
          <td class="mono">{{ conditionText(r) }}<span v-if="r.recover_threshold !== null" class="muted"> (recover {{ toDisplay(r.metric, r.recover_threshold) }}{{ unitSuffix(r.metric) }})</span></td>
          <td class="num">{{ r.duration_min }} min</td>
          <td><span class="badge" :class="r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'offline'">{{ r.severity }}</span></td>
          <td class="muted">{{ r.scope_type }}{{ r.scope_ids?.length ? ` (${r.scope_ids.length})` : '' }}</td>
          <!-- A rule with no channel still opens incidents; it just never
               notifies anyone. That is invisible until an outage, so name it. -->
          <td>
            <span v-if="(r.channels || []).length" class="muted">{{ r.channels.join(', ') }}</span>
            <span v-else class="nochan" :title="channels.length
              ? 'This rule opens incidents but sends no notification. Edit it and pick a channel.'
              : 'No notification channels exist yet — add one in Settings.'">no channel</span>
          </td>
          <td><span class="badge" :class="r.enabled ? 'online' : 'offline'">{{ r.enabled ? 'on' : 'off' }}</span></td>
          <td>
            <button v-if="r.pack_binding_id" class="sm" @click="tab = 'packs'">Open pack</button>
            <template v-else-if="auth.isAdmin">
              <button class="sm" @click="edit(r)">Edit</button>
              <button class="sm" @click="toggle(r)">{{ r.enabled ? 'Disable' : 'Enable' }}</button>
              <button class="sm danger" @click="del(r)">Delete</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rules.length"><td colspan="8" class="empty">No rules defined.</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Rule builder -->
  <div v-if="editing" class="modal-wrap" @click.self="editing = null">
    <form class="card modal" @submit.prevent="save">
      <h2>{{ editing.id ? 'Edit rule' : 'New rule' }}</h2>
      <label class="f">Name <input v-model="editing.name" required placeholder="High RAM" /></label>
      <div class="row">
        <label class="f" style="flex: 2">Metric
          <select v-model="editing.metric">
            <option v-for="m in METRICS" :key="m[0]" :value="m[0]">{{ m[1] }}</option>
          </select>
        </label>
        <label class="f">Comparator
          <select v-model="editing.comparator">
            <option v-for="c in ['>', '>=', '<', '<=', '==', '!=']" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <label class="f">Threshold{{ unitSuffix(editing.metric) ? ` (${unitSuffix(editing.metric).trim()})` : '' }}
          <input v-model="editing.threshold" type="number" step="any" style="width: 110px" /></label>
      </div>
      <div class="row">
        <label class="f">For (minutes) <input v-model="editing.duration_min" type="number" min="0" step="any" style="width: 110px" /></label>
        <label class="f">Recover threshold (optional)
          <input v-model="editing.recover_threshold" type="number" step="any" placeholder="hysteresis" style="width: 150px" /></label>
        <label class="f">Severity
          <select v-model="editing.severity">
            <option v-for="s in ['critical', 'warning', 'info']" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label class="f">Scope
          <select v-model="editing.scope_type" @change="editing.scope_ids = []">
            <option value="all">All servers</option>
            <option value="project">Groups</option>
            <option value="servers">Specific servers</option>
          </select>
        </label>
        <label v-if="editing.scope_type === 'project'" class="f" style="flex: 1">Groups
          <select v-model="editing.scope_ids" multiple size="4">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label v-if="editing.scope_type === 'servers'" class="f" style="flex: 1">Servers
          <select v-model="editing.scope_ids" multiple size="4">
            <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
      </div>
      <label class="f">Notification channels
        <select v-model="editing.channels" multiple size="3">
          <option v-for="c in channels" :key="c.id" :value="c.name">{{ c.name }} ({{ c.type }})</option>
        </select>
        <span class="muted" v-if="!channels.length">No channels configured — add one in Settings.</span>
      </label>
      <div class="row">
        <label class="f">Flap limit <input v-model="editing.flap_limit" type="number" min="1" style="width: 90px" /></label>
        <label class="f">Flap window (min) <input v-model="editing.flap_window_min" type="number" min="1" style="width: 110px" /></label>
        <label class="f" style="flex-direction: row; align-items: center; gap: 6px; margin-top: 14px">
          <input v-model="editing.enabled" type="checkbox" style="width: auto" /> Enabled
        </label>
      </div>
      <div class="row" style="justify-content: flex-end; margin-top: 6px">
        <button type="button" @click="editing = null">Cancel</button>
        <button class="primary" type="submit">Save rule</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.notice {
  background: color-mix(in oklab, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in oklab, var(--warning) 40%, var(--border));
  border-radius: 10px; padding: 9px 12px; margin-bottom: 12px; font-size: 13px;
}
.packtag { margin-left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted, inherit); }
.nochan { color: var(--warning); font-weight: 600; font-size: 12px; cursor: help; }
.modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: grid; place-items: center; z-index: 40; }
.modal { width: 640px; max-width: 94vw; max-height: 90vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
</style>
