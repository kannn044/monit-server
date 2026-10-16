<script setup>
// Rule packs: one set of rules, applied to whole groups at once.
// Applying creates a "binding" per group (or one for all servers); each binding
// owns ordinary alert rules that the engine evaluates per server, so a server
// joining the group is covered automatically.
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';
import { useAuth } from '../stores/auth.js';
import { METRICS, toDisplay, fromDisplay, conditionText, unitSuffix } from '../metrics-catalog.js';

const props = defineProps({
  channels: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  servers: { type: Array, default: () => [] },
});
const emit = defineEmits(['changed']);
const auth = useAuth();

const packs = ref([]);
const error = ref('');
const editingPack = ref(null);   // pack form
const applying = ref(null);      // { pack, scope_type, scope_ids, per_group, channels }
const editingBinding = ref(null); // { pack, binding, overrides (display units) }

const projectName = (id) => props.projects.find((p) => p.id === id)?.name || id;
const serverName = (id) => props.servers.find((s) => s.id === id)?.name || id;
function scopeText(b) {
  if (b.scope_type === 'all') return 'All servers';
  if (b.scope_type === 'servers') return `Servers: ${(b.scope_ids || []).map(serverName).join(', ')}`;
  return `Group: ${(b.scope_ids || []).map(projectName).join(', ')}`;
}
// groups that already have this pack — applying twice would double every alert
const boundGroups = (pack) => new Set(pack.bindings.filter((b) => b.scope_type === 'project').flatMap((b) => b.scope_ids));

async function load() {
  try { packs.value = (await api('/api/v1/rule-packs')).packs; error.value = ''; } catch (e) { error.value = e.message; }
}
onMounted(load);
async function changed() { await load(); emit('changed'); }

// ---- pack editor --------------------------------------------------------
const blankItem = () => ({
  name: '', metric: 'cpu.total', comparator: '>', threshold: 90, duration_min: 5,
  recover_threshold: null, severity: 'warning', flap_limit: 5, flap_window_min: 30,
});
function editPack(p) {
  editingPack.value = p
    ? {
      id: p.id, name: p.name, description: p.description,
      items: p.items.map((i) => ({
        ...i, threshold: toDisplay(i.metric, i.threshold), recover_threshold: toDisplay(i.metric, i.recover_threshold),
      })),
    }
    : { name: '', description: '', items: [blankItem()] };
}
async function savePack() {
  const p = editingPack.value;
  const body = {
    name: p.name, description: p.description || '',
    items: p.items.map((i) => ({
      ...(i.id ? { id: i.id } : {}),
      name: i.name || i.metric, metric: i.metric, comparator: i.comparator,
      threshold: fromDisplay(i.metric, i.threshold),
      recover_threshold: fromDisplay(i.metric, i.recover_threshold),
      duration_min: Number(i.duration_min) || 0, severity: i.severity,
      flap_limit: Number(i.flap_limit) || 5, flap_window_min: Number(i.flap_window_min) || 30,
    })),
  };
  try {
    if (p.id) await api(`/api/v1/rule-packs/${p.id}`, { method: 'PUT', body });
    else await api('/api/v1/rule-packs', { method: 'POST', body });
    editingPack.value = null;
    await changed();
  } catch (e) { error.value = e.message; }
}
async function deletePack(p) {
  if (!confirm(`Delete rule pack "${p.name}"?\n\nThis removes ${p.bindings.length} application(s) and every alert rule they created. Open incidents from them are resolved.`)) return;
  try { await api(`/api/v1/rule-packs/${p.id}`, { method: 'DELETE' }); await changed(); } catch (e) { error.value = e.message; }
}

// ---- apply --------------------------------------------------------------
function startApply(p) {
  applying.value = { pack: p, scope_type: 'project', scope_ids: [], per_group: true, channels: [] };
}
const applyWarn = computed(() => {
  const a = applying.value;
  if (!a || a.scope_type !== 'project') return '';
  const dup = a.scope_ids.filter((g) => boundGroups(a.pack).has(g)).map(projectName);
  return dup.length ? `Already applied to: ${dup.join(', ')} — applying again doubles those alerts.` : '';
});
async function apply() {
  const a = applying.value;
  try {
    await api(`/api/v1/rule-packs/${a.pack.id}/apply`, {
      method: 'POST',
      body: { scope_type: a.scope_type, scope_ids: a.scope_type === 'all' ? [] : a.scope_ids, per_group: a.per_group, channels: a.channels },
    });
    applying.value = null;
    await changed();
  } catch (e) { error.value = e.message; }
}

// ---- binding editor (channels, enable, per-group overrides) -------------
function editBinding(pack, b) {
  const ov = {};
  for (const it of pack.items) {
    const o = b.overrides?.[it.id] || {};
    ov[it.id] = {
      enabled: o.enabled !== false,
      threshold: toDisplay(it.metric, o.threshold ?? null),
      recover_threshold: toDisplay(it.metric, o.recover_threshold ?? null),
      duration_min: o.duration_min ?? null,
      severity: o.severity ?? '',
    };
  }
  editingBinding.value = {
    pack, binding: b, channels: [...(b.channels || [])], enabled: b.enabled,
    scope_ids: [...(b.scope_ids || [])], overrides: ov,
  };
}
async function saveBinding() {
  const e = editingBinding.value;
  const overrides = {};
  for (const it of e.pack.items) {
    const o = e.overrides[it.id];
    const out = {};
    if (!o.enabled) out.enabled = false;
    const th = fromDisplay(it.metric, o.threshold); if (th !== null) out.threshold = th;
    const rt = fromDisplay(it.metric, o.recover_threshold); if (rt !== null) out.recover_threshold = rt;
    if (o.duration_min !== null && o.duration_min !== '') out.duration_min = Number(o.duration_min);
    if (o.severity) out.severity = o.severity;
    if (Object.keys(out).length) overrides[it.id] = out;
  }
  try {
    await api(`/api/v1/rule-pack-bindings/${e.binding.id}`, {
      method: 'PUT',
      body: { channels: e.channels, enabled: e.enabled, overrides, scope_ids: e.binding.scope_type === 'all' ? [] : e.scope_ids },
    });
    editingBinding.value = null;
    await changed();
  } catch (err) { error.value = err.message; }
}
async function removeBinding(pack, b) {
  if (!confirm(`Stop applying "${pack.name}" to ${scopeText(b)}?\n\nIts ${b.rule_count} alert rule(s) are deleted and their open incidents resolved.`)) return;
  try { await api(`/api/v1/rule-pack-bindings/${b.id}`, { method: 'DELETE' }); await changed(); } catch (e) { error.value = e.message; }
}
async function toggleBinding(b) {
  try { await api(`/api/v1/rule-pack-bindings/${b.id}`, { method: 'PUT', body: { enabled: !b.enabled } }); await changed(); } catch (e) { error.value = e.message; }
}
</script>

<template>
  <div v-if="error" class="error-banner">{{ error }}</div>
  <div class="row" style="justify-content: space-between; margin-bottom: 10px">
    <div class="muted" style="max-width: 760px">
      A rule pack is a set of rules you define once and apply to whole groups. Every server in the group —
      including servers added later — is checked on its own. Thresholds can be overridden per group.
      If the same metric also has a global ("All servers") rule, you will get two alerts — disable one.
    </div>
    <button v-if="auth.isAdmin" class="primary" @click="editPack(null)">New pack</button>
  </div>

  <div class="grid">
    <div v-for="p in packs" :key="p.id" class="card">
      <div class="row" style="justify-content: space-between">
        <div>
          <h2 style="margin: 0">{{ p.name }}</h2>
          <div class="muted" v-if="p.description">{{ p.description }}</div>
        </div>
        <div v-if="auth.isAdmin" class="row">
          <button class="sm primary" @click="startApply(p)">Apply to groups…</button>
          <button class="sm" @click="editPack(p)">Edit pack</button>
          <button class="sm danger" @click="deletePack(p)">Delete</button>
        </div>
      </div>

      <table style="margin-top: 8px">
        <thead><tr><th>Rule</th><th>Condition</th><th>For</th><th>Severity</th></tr></thead>
        <tbody>
          <tr v-for="i in p.items" :key="i.id">
            <td>{{ i.name }}</td>
            <td class="mono">{{ conditionText(i) }}<span v-if="i.recover_threshold !== null" class="muted"> (recover {{ toDisplay(i.metric, i.recover_threshold) }}{{ unitSuffix(i.metric) }})</span></td>
            <td class="num">{{ i.duration_min }} min</td>
            <td><span class="badge" :class="i.severity === 'critical' ? 'critical' : i.severity === 'warning' ? 'warning' : 'offline'">{{ i.severity }}</span></td>
          </tr>
          <tr v-if="!p.items.length"><td colspan="4" class="empty">No rules in this pack yet.</td></tr>
        </tbody>
      </table>

      <h3 class="muted" style="font-size: 12px; margin: 14px 0 4px">Applied to</h3>
      <table>
        <tbody>
          <tr v-for="b in p.bindings" :key="b.id">
            <td><b>{{ scopeText(b) }}</b>
              <span v-if="Object.keys(b.overrides || {}).length" class="tag" title="Some thresholds differ from the pack">overrides</span></td>
            <td>
              <span v-if="(b.channels || []).length" class="muted">{{ b.channels.join(', ') }}</span>
              <span v-else class="nochan">no channel</span>
            </td>
            <td class="muted num">{{ b.rule_count }} rules</td>
            <td><span v-if="b.open_incidents" class="badge critical">{{ b.open_incidents }} open</span></td>
            <td><span class="badge" :class="b.enabled ? 'online' : 'offline'">{{ b.enabled ? 'on' : 'off' }}</span></td>
            <td v-if="auth.isAdmin" style="white-space: nowrap">
              <button class="sm" @click="editBinding(p, b)">Edit</button>
              <button class="sm" @click="toggleBinding(b)">{{ b.enabled ? 'Disable' : 'Enable' }}</button>
              <button class="sm danger" @click="removeBinding(p, b)">Remove</button>
            </td>
          </tr>
          <tr v-if="!p.bindings.length"><td colspan="6" class="empty">Not applied anywhere yet.</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="!packs.length" class="card empty">No rule packs yet.</div>
  </div>

  <!-- Pack editor -->
  <div v-if="editingPack" class="modal-wrap" @click.self="editingPack = null">
    <form class="card modal wide" @submit.prevent="savePack">
      <h2>{{ editingPack.id ? 'Edit rule pack' : 'New rule pack' }}</h2>
      <div class="row">
        <label class="f" style="flex: 1">Name <input v-model="editingPack.name" required placeholder="Linux baseline" /></label>
        <label class="f" style="flex: 2">Description <input v-model="editingPack.description" /></label>
      </div>
      <table class="items">
        <thead><tr><th>Name</th><th>Metric</th><th></th><th>Threshold</th><th>Recover</th><th>For (min)</th><th>Severity</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(i, idx) in editingPack.items" :key="i.id || idx">
            <td><input v-model="i.name" placeholder="name" style="width: 130px" /></td>
            <td><select v-model="i.metric" style="width: 210px">
              <option v-for="m in METRICS" :key="m[0]" :value="m[0]">{{ m[1] }}</option></select></td>
            <td><select v-model="i.comparator">
              <option v-for="c in ['>', '>=', '<', '<=', '==', '!=']" :key="c" :value="c">{{ c }}</option></select></td>
            <td><input v-model="i.threshold" type="number" step="any" style="width: 90px" :placeholder="unitSuffix(i.metric).trim()" /></td>
            <td><input v-model="i.recover_threshold" type="number" step="any" style="width: 80px" placeholder="—" /></td>
            <td><input v-model="i.duration_min" type="number" min="0" step="any" style="width: 70px" /></td>
            <td><select v-model="i.severity">
              <option v-for="s in ['critical', 'warning', 'info']" :key="s" :value="s">{{ s }}</option></select></td>
            <td><button type="button" class="sm danger" @click="editingPack.items.splice(idx, 1)">✕</button></td>
          </tr>
        </tbody>
      </table>
      <div><button type="button" class="sm" @click="editingPack.items.push(blankItem())">+ Add rule</button></div>
      <div class="muted" style="font-size: 12px">Saving updates every group this pack is applied to.</div>
      <div class="row" style="justify-content: flex-end">
        <button type="button" @click="editingPack = null">Cancel</button>
        <button class="primary" type="submit">Save pack</button>
      </div>
    </form>
  </div>

  <!-- Apply -->
  <div v-if="applying" class="modal-wrap" @click.self="applying = null">
    <form class="card modal mid" @submit.prevent="apply">
      <h2>Apply “{{ applying.pack.name }}”</h2>
      <label class="f">Apply to
        <select v-model="applying.scope_type" @change="applying.scope_ids = []">
          <option value="project">Groups</option>
          <option value="all">All servers</option>
          <option value="servers">Specific servers</option>
        </select>
      </label>
      <label v-if="applying.scope_type === 'project'" class="f">Groups (Ctrl/⌘-click for several)
        <select v-model="applying.scope_ids" multiple size="6">
          <option v-for="g in projects" :key="g.id" :value="g.id">{{ g.name }} ({{ g.environment }}, {{ g.server_count }} servers)</option>
        </select>
      </label>
      <label v-if="applying.scope_type === 'servers'" class="f">Servers
        <select v-model="applying.scope_ids" multiple size="6">
          <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label v-if="applying.scope_type === 'project' && applying.scope_ids.length > 1"
             class="f" style="flex-direction: row; align-items: center; gap: 6px">
        <input v-model="applying.per_group" type="checkbox" style="width: auto" />
        Separate entry per group (lets you override thresholds per group later)
      </label>
      <label class="f">Notification channels
        <select v-model="applying.channels" multiple size="3">
          <option v-for="c in channels" :key="c.id" :value="c.name">{{ c.name }} ({{ c.type }})</option>
        </select>
      </label>
      <div v-if="applyWarn" class="warn">{{ applyWarn }}</div>
      <div class="row" style="justify-content: flex-end">
        <button type="button" @click="applying = null">Cancel</button>
        <button class="primary" type="submit" :disabled="applying.scope_type !== 'all' && !applying.scope_ids.length">Apply</button>
      </div>
    </form>
  </div>

  <!-- Binding editor -->
  <div v-if="editingBinding" class="modal-wrap" @click.self="editingBinding = null">
    <form class="card modal wide" @submit.prevent="saveBinding">
      <h2>{{ editingBinding.pack.name }} — {{ scopeText(editingBinding.binding) }}</h2>
      <div class="row">
        <label v-if="editingBinding.binding.scope_type === 'project'" class="f" style="flex: 1">Groups
          <select v-model="editingBinding.scope_ids" multiple size="4">
            <option v-for="g in projects" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>
        <label v-if="editingBinding.binding.scope_type === 'servers'" class="f" style="flex: 1">Servers
          <select v-model="editingBinding.scope_ids" multiple size="4">
            <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label class="f" style="flex: 1">Notification channels
          <select v-model="editingBinding.channels" multiple size="4">
            <option v-for="c in channels" :key="c.id" :value="c.name">{{ c.name }} ({{ c.type }})</option>
          </select>
        </label>
      </div>
      <div class="muted" style="font-size: 12px">Overrides for this scope only — leave blank to use the pack value.</div>
      <table class="items">
        <thead><tr><th>On</th><th>Rule</th><th>Threshold</th><th>Recover</th><th>For (min)</th><th>Severity</th></tr></thead>
        <tbody>
          <tr v-for="it in editingBinding.pack.items" :key="it.id">
            <td><input v-model="editingBinding.overrides[it.id].enabled" type="checkbox" style="width: auto" /></td>
            <td>{{ it.name }} <span class="muted mono">{{ it.metric }} {{ it.comparator }}</span></td>
            <td><input v-model="editingBinding.overrides[it.id].threshold" type="number" step="any" style="width: 90px"
                       :placeholder="`${toDisplay(it.metric, it.threshold)}${unitSuffix(it.metric)}`" /></td>
            <td><input v-model="editingBinding.overrides[it.id].recover_threshold" type="number" step="any" style="width: 80px"
                       :placeholder="it.recover_threshold === null ? '—' : String(toDisplay(it.metric, it.recover_threshold))" /></td>
            <td><input v-model="editingBinding.overrides[it.id].duration_min" type="number" min="0" step="any" style="width: 70px"
                       :placeholder="String(it.duration_min)" /></td>
            <td><select v-model="editingBinding.overrides[it.id].severity">
              <option value="">({{ it.severity }})</option>
              <option v-for="s in ['critical', 'warning', 'info']" :key="s" :value="s">{{ s }}</option></select></td>
          </tr>
        </tbody>
      </table>
      <label class="f" style="flex-direction: row; align-items: center; gap: 6px">
        <input v-model="editingBinding.enabled" type="checkbox" style="width: auto" /> Enabled
      </label>
      <div class="row" style="justify-content: flex-end">
        <button type="button" @click="editingBinding = null">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.modal.wide { width: 960px; max-height: 90vh; overflow: auto; }
.modal.mid { width: 520px; }
.items td { padding: 5px 6px; }
.items input, .items select { padding: 5px 7px; }
.tag { margin-left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); }
.nochan { color: var(--warning); font-weight: 600; font-size: 12px; }
.warn { color: var(--warning); font-size: 12px; }
</style>
