<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';
import { ago } from '../util.js';
import { useAuth } from '../stores/auth.js';
import AgentSetup from '../components/AgentSetup.vue';

// "Group" in the UI is the `projects` table in the API and database — one
// concept, one name on screen. A server belongs to exactly one group, so every
// control here is a single select and assignment replaces rather than adds.
const auth = useAuth();
const groups = ref([]);
const servers = ref([]);
const archived = ref([]);
const error = ref('');
const notice = ref('');
const newGroup = ref({ name: '', environment: 'Prod' });
const newServer = ref({ id: '', name: '', ip: '', group_id: '' });
const issuedKey = ref(null);
const editingServer = ref(null);
const removing = ref(null);
const selected = ref(new Set());
const bulkTarget = ref('');
const filterGroup = ref('');
const search = ref('');
const agentUrl = ref('');
const addOpen = ref(false);

const groupOf = (s) => s.projects?.[0] || null;

async function load() {
  try {
    const [p, s, a, cfg] = await Promise.all([
      api('/api/v1/projects'),
      api('/api/v1/servers'),
      api('/api/v1/servers?archived=only'),
      // The address agents use is not the address this page is open at, so it
      // has to be read from the server rather than guessed from the browser.
      api('/api/v1/settings/agent-url').catch(() => ({ agent_api_url: '' })),
    ]);
    groups.value = p.projects; servers.value = s.servers; archived.value = a.servers;
    agentUrl.value = cfg.agent_api_url || '';
    // Drop anything that no longer exists so the bulk bar cannot act on ghosts.
    const live = new Set(s.servers.map((x) => x.id));
    selected.value = new Set([...selected.value].filter((id) => live.has(id)));
    error.value = '';
  } catch (e) { error.value = e.message; }
}
onMounted(load);

const visibleServers = computed(() => {
  let list = [...servers.value];
  if (filterGroup.value === '__none') list = list.filter((s) => !groupOf(s));
  else if (filterGroup.value) list = list.filter((s) => groupOf(s)?.id === filterGroup.value);
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase();
    list = list.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }
  // Ungrouped first: those are the ones still needing a decision.
  return list.sort((a, b) => {
    const ga = groupOf(a)?.name || '';
    const gb = groupOf(b)?.name || '';
    if (ga !== gb) return (ga === '' ? -1 : gb === '' ? 1 : ga.localeCompare(gb));
    return a.name.localeCompare(b.name);
  });
});

const ungroupedCount = computed(() => servers.value.filter((s) => !groupOf(s)).length);
const allVisibleSelected = computed(() =>
  visibleServers.value.length > 0 && visibleServers.value.every((s) => selected.value.has(s.id)));

function toggleOne(id) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}
function toggleAllVisible() {
  const next = new Set(selected.value);
  if (allVisibleSelected.value) visibleServers.value.forEach((s) => next.delete(s.id));
  else visibleServers.value.forEach((s) => next.add(s.id));
  selected.value = next;
}

async function assignSelected() {
  const ids = [...selected.value];
  if (!ids.length) return;
  const target = bulkTarget.value;
  const label = target === '__none' ? 'Ungrouped' : groups.value.find((g) => g.id === target)?.name;
  if (!confirm(`Move ${ids.length} server${ids.length > 1 ? 's' : ''} to "${label}"?`)) return;
  try {
    const r = await api('/api/v1/servers/bulk/group', {
      method: 'POST',
      body: { server_ids: ids, project_id: target === '__none' ? null : target },
    });
    notice.value = `Moved ${r.updated} server${r.updated > 1 ? 's' : ''} to "${label}".`;
    selected.value = new Set();
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}

// Changing one server's group straight from its row — no modal for the common case.
async function setGroup(s, groupId) {
  try {
    await api(`/api/v1/servers/${s.id}`, {
      method: 'PATCH',
      body: { project_ids: groupId ? [groupId] : [] },
    });
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}

async function createGroup() {
  try {
    await api('/api/v1/projects', { method: 'POST', body: newGroup.value });
    newGroup.value = { name: '', environment: 'Prod' };
    await load();
  } catch (e) { error.value = e.message; }
}

async function delGroup(g) {
  const n = g.server_count;
  if (!confirm(`Archive group "${g.name}"?${n ? `\n\n${n} server${n > 1 ? 's' : ''} will become Ungrouped. The servers themselves are not touched.` : ''}`)) return;
  try {
    await api(`/api/v1/projects/${g.id}`, { method: 'DELETE' });
    notice.value = `Group "${g.name}" archived.${n ? ` ${n} server${n > 1 ? 's are' : ' is'} now Ungrouped.` : ''}`;
    await load();
  } catch (e) { error.value = e.message; }
}

async function createServer() {
  try {
    const body = {
      id: newServer.value.id, name: newServer.value.name, ip: newServer.value.ip,
      project_ids: newServer.value.group_id ? [newServer.value.group_id] : [],
    };
    const r = await api('/api/v1/servers', { method: 'POST', body });
    issuedKey.value = {
      id: r.server.id, key: r.api_key, ip: newServer.value.ip || '',
      title: r.revived ? 'Server restored — install the agent again' : 'Server registered',
      rotated: false,
      // Minted alongside the key so the install line is ready immediately; null
      // if that failed, in which case the panel offers to create one.
      install: r.install || null,
    };
    notice.value = r.revived
      ? `"${r.server.id}" was previously deleted; its registration has been restored and a new key issued.`
      : '';
    newServer.value = { id: '', name: '', ip: '', group_id: '' };
    addOpen.value = false;
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}

async function saveServer() {
  const s = editingServer.value;
  try {
    await api(`/api/v1/servers/${s.id}`, {
      method: 'PATCH',
      body: { name: s.name, ip: s.ip || undefined, project_ids: s.group_id ? [s.group_id] : [] },
    });
    editingServer.value = null;
    await load();
  } catch (e) { error.value = e.message; }
}

// A fresh install link for a server registered earlier. It issues a new key, so
// say that plainly first — on a host that is already reporting this is a
// deliberate replacement, not a read-only action.
async function installLink(s) {
  const live = s.health && s.health !== 'offline' && s.health !== 'unknown';
  const warning = live
    ? `"${s.name}" is reporting right now.\n\nA new install link replaces its agent key, so the agent on that host stops reporting until the link is run there.\n\nContinue?`
    : `Create an install link for "${s.name}"?\n\nIt works once, expires in 15 minutes, and issues a new agent key.`;
  if (!confirm(warning)) return;
  try {
    const r = await api(`/api/v1/servers/${s.id}/install-token`, { method: 'POST' });
    issuedKey.value = {
      id: s.id, key: '', ip: s.ip || '', title: `Install ${s.name}`, rotated: false,
      install: { token: r.token, expires_at: r.expires_at },
    };
    notice.value = '';
    error.value = '';
  } catch (e) { error.value = e.message; }
}

// Keys are stored as SHA-256 hashes, so a forgotten key cannot be looked up —
// issuing a replacement is the only recovery, and it is one click from the list.
async function newKey(s) {
  if (!confirm(`Issue a new agent key for "${s.name}"?\n\nThe current key stops working immediately — the agent will not report again until the new key is installed on that host.`)) return;
  try {
    const r = await api(`/api/v1/servers/${s.id}/keys/rotate`, { method: 'POST' });
    issuedKey.value = { id: s.id, key: r.api_key, ip: s.ip || '', title: 'New agent key', rotated: true };
    notice.value = '';
    error.value = '';
  } catch (e) { error.value = e.message; }
}

async function confirmRemove() {
  const { server, mode } = removing.value;
  try {
    const qs = mode === 'purge' ? '?purge=1' : '';
    const r = await api(`/api/v1/servers/${server.id}${qs}`, { method: 'DELETE' });
    notice.value = mode === 'purge'
      ? `"${server.id}" was erased${r.samples_deleted ? ` along with ${r.samples_deleted.toLocaleString()} stored samples` : ''}. The ID is free to reuse.`
      : `"${server.id}" was moved to Deleted servers. Registering the same ID again will restore it with a new key.`;
    removing.value = null;
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}

async function restore(s) {
  try {
    const r = await api(`/api/v1/servers/${s.id}/restore`, { method: 'POST' });
    issuedKey.value = { id: s.id, key: r.api_key, ip: s.ip || '', title: 'Server restored', rotated: false };
    notice.value = '';
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}
</script>

<template>
  <h1>Groups &amp; servers</h1>
  <div v-if="error" class="error-banner">{{ error }}</div>
  <div v-if="notice" class="notice">{{ notice }} <button class="sm" @click="notice = ''">Dismiss</button></div>

  <!-- Adding a server is what people come to this page to do, so it opens the
       page. The inventory below is reference; this is the action. -->
  <section v-if="auth.isOperator" class="addcard">
    <div class="addhead">
      <div>
        <h2>Add a server to monitor</h2>
        <p class="sub">
          Registering issues the agent key and an install link. The next screen gives you one
          line to run on the machine itself — no account on this server needed, and no key to
          copy by hand.
        </p>
      </div>
      <button v-if="!addOpen" class="primary" @click="addOpen = true">Add a server</button>
    </div>

    <form v-if="addOpen" class="addform" @submit.prevent="createServer">
      <label class="f">
        Server ID
        <input v-model="newServer.id" placeholder="mysql-cluster-mysqld2" required
               pattern="[A-Za-z0-9._\-]+" spellcheck="false" />
        <span class="fh">Used in commands and alerts. Letters, numbers, dot, dash, underscore.</span>
      </label>
      <label class="f">
        Display name
        <input v-model="newServer.name" placeholder="MySQL cluster — SQL node 2" required />
        <span class="fh">What you will read on the Fleet page.</span>
      </label>
      <label class="f short">
        IP address
        <input v-model="newServer.ip" placeholder="10.1.0.222" spellcheck="false" />
        <span class="fh">Optional, but it prefills the install command.</span>
      </label>
      <label class="f short">
        Group
        <select v-model="newServer.group_id">
          <option value="">— No group —</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
        <span class="fh">Can be changed any time.</span>
      </label>
      <div class="addactions">
        <button type="button" @click="addOpen = false">Cancel</button>
        <button class="primary" type="submit">Register &amp; show install command</button>
      </div>
    </form>

    <p v-if="addOpen && !agentUrl" class="warnline">
      <b>Set the agent address first.</b>
      Admins: Settings → “Address agents connect to”. Without it the install command
      cannot be completed — it is the host and port agents post to
      (e.g. <span class="mono">http://10.1.1.171:8080</span>), not this dashboard's address.
    </p>
  </section>

  <AgentSetup v-if="issuedKey" :server-id="issuedKey.id" :api-key="issuedKey.key"
              :server-ip="issuedKey.ip" :agent-url="agentUrl" :title="issuedKey.title"
              :rotated="issuedKey.rotated" :install="issuedKey.install || null"
              @dismiss="issuedKey = null" />

  <div class="card">
    <div class="row" style="justify-content: space-between; align-items: baseline">
      <h2>Groups</h2>
      <span v-if="ungroupedCount" class="muted" style="font-size: 12px">
        {{ ungroupedCount }} server{{ ungroupedCount > 1 ? 's' : '' }} not in a group
      </span>
    </div>
    <div class="glist">
      <div v-for="g in groups" :key="g.id" class="gchip" :class="{ on: filterGroup === g.id }"
           @click="filterGroup = filterGroup === g.id ? '' : g.id">
        <b>{{ g.name }}</b>
        <span class="env">{{ g.environment }}</span>
        <span class="n">{{ g.server_count }}</span>
        <button v-if="auth.isAdmin" class="x" title="Archive this group" @click.stop="delGroup(g)">×</button>
      </div>
      <div v-if="ungroupedCount" class="gchip none" :class="{ on: filterGroup === '__none' }"
           @click="filterGroup = filterGroup === '__none' ? '' : '__none'">
        <b>Ungrouped</b><span class="n">{{ ungroupedCount }}</span>
      </div>
      <span v-if="!groups.length" class="muted" style="font-size: 12px">
        {{ auth.isAdmin ? 'No groups yet — add one below.' : 'No groups yet — an admin creates these.' }}
      </span>
    </div>

    <form v-if="auth.isAdmin" class="row" style="margin-top: 12px" @submit.prevent="createGroup">
      <input v-model="newGroup.name" placeholder="New group name (e.g. Core Platform)" required style="flex: 1; max-width: 320px" />
      <input v-model="newGroup.environment" placeholder="Prod" style="width: 90px" />
      <button class="primary" type="submit">Add group</button>
    </form>
  </div>

  <div class="card" style="margin-top: 12px">
    <div class="row" style="justify-content: space-between; align-items: center; flex-wrap: wrap">
      <h2 style="margin: 0">Servers</h2>
      <div class="row" style="gap: 8px">
        <input v-model="search" placeholder="Search…" style="width: 160px" />
        <select v-model="filterGroup" style="width: 160px">
          <option value="">All groups</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          <option value="__none">Ungrouped</option>
        </select>
      </div>
    </div>

    <!-- Bulk bar: the whole point of the redesign. Assigning 14 hosts one at a
         time is why grouping went unused. -->
    <div v-if="auth.isOperator && selected.size" class="bulk">
      <b>{{ selected.size }} selected</b>
      <select v-model="bulkTarget" style="width: 190px">
        <option value="">Move to group…</option>
        <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        <option value="__none">Ungrouped (remove)</option>
      </select>
      <button class="primary sm" :disabled="!bulkTarget" @click="assignSelected">Apply</button>
      <button class="sm" @click="selected = new Set()">Clear</button>
    </div>

    <table>
      <thead>
        <tr>
          <th v-if="auth.isOperator" style="width: 26px">
            <input type="checkbox" :checked="allVisibleSelected" title="Select all shown"
                   style="width: auto" @change="toggleAllVisible" />
          </th>
          <th>Name</th><th>ID</th><th>Group</th><th>Health</th><th>Last seen</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in visibleServers" :key="s.id" :class="{ sel: selected.has(s.id) }">
          <td v-if="auth.isOperator">
            <input type="checkbox" :checked="selected.has(s.id)" style="width: auto" @change="toggleOne(s.id)" />
          </td>
          <td><router-link :to="`/servers/${s.id}`">{{ s.name }}</router-link></td>
          <td class="mono muted nowrap">{{ s.id }}</td>
          <td>
            <select v-if="auth.isOperator" class="ginline" :class="{ unset: !groupOf(s) }"
                    :value="groupOf(s)?.id || ''" @change="setGroup(s, $event.target.value)">
              <option value="">— Ungrouped —</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <span v-else class="muted">{{ groupOf(s)?.name || '—' }}</span>
          </td>
          <td><span class="badge" :class="s.health">{{ s.health }}</span></td>
          <td class="muted">{{ ago(s.last_seen) }}</td>
          <td class="acts">
            <button v-if="auth.isOperator" class="sm"
                    @click="editingServer = { ...s, group_id: groupOf(s)?.id || '', ip: s.ip || '' }">Edit</button>
            <!-- The way back for "I registered it last week and never installed
                 the agent", and the only route for a machine whose key is lost. -->
            <button v-if="auth.isOperator" class="sm"
                    title="Get a one-line install command for this server"
                    @click="installLink(s)">Install</button>
            <!-- Issuing a key stops the running agent until the new one is
                 installed, and Delete can erase the metric history, so both
                 stay with admins even though operators manage servers. -->
            <template v-if="auth.isAdmin">
              <button class="sm" title="Issue a replacement key — forgotten keys cannot be looked up" @click="newKey(s)">New key</button>
              <button class="sm danger" @click="removing = { server: s, mode: 'archive' }">Delete</button>
            </template>
          </td>
        </tr>
        <tr v-if="!visibleServers.length">
          <td :colspan="auth.isOperator ? 7 : 6" class="empty">
            {{ servers.length ? 'No servers match the filter.' : 'No servers registered.' }}
          </td>
        </tr>
      </tbody>
    </table>

  </div>

  <div v-if="auth.isAdmin && archived.length" class="card" style="margin-top: 12px">
    <h2>Deleted servers</h2>
    <p class="muted" style="font-size: 12px; margin: 0 0 8px">
      Hidden from every dashboard and their keys are revoked, but the ID and metric history are still held.
      Restore to bring one back with a new key, or erase to free the ID and drop its stored samples.
    </p>
    <table>
      <thead><tr><th>Name</th><th>ID</th><th>Deleted</th><th>Last seen</th><th></th></tr></thead>
      <tbody>
        <tr v-for="s in archived" :key="s.id">
          <td>{{ s.name }}</td>
          <td class="mono muted">{{ s.id }}</td>
          <td class="muted">{{ ago(s.archived_at) }}</td>
          <td class="muted">{{ ago(s.last_seen) }}</td>
          <td class="acts">
            <button class="sm" @click="restore(s)">Restore</button>
            <button class="sm danger" @click="removing = { server: s, mode: 'purge', archivedOnly: true }">Erase permanently</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="editingServer" class="modal-wrap" @click.self="editingServer = null">
    <form class="card modal" @submit.prevent="saveServer">
      <h2>Edit {{ editingServer.id }}</h2>
      <label class="f">Display name <input v-model="editingServer.name" required /></label>
      <label class="f">IP <input v-model="editingServer.ip" placeholder="10.0.0.5" /></label>
      <label class="f">Group
        <select v-model="editingServer.group_id">
          <option value="">— Ungrouped —</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }} ({{ g.environment }})</option>
        </select>
      </label>
      <div class="row" style="justify-content: flex-end">
        <button type="button" @click="editingServer = null">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>
  </div>

  <!-- Delete: two genuinely different outcomes, so it asks rather than guessing. -->
  <div v-if="removing" class="modal-wrap" @click.self="removing = null">
    <div class="card modal">
      <h2>Delete {{ removing.server.name }}</h2>
      <label class="opt" :class="{ on: removing.mode === 'archive' }" v-if="!removing.archivedOnly">
        <input type="radio" value="archive" v-model="removing.mode" />
        <div>
          <b>Remove from the dashboard</b>
          <div class="muted">Key revoked, alerts closed, hidden everywhere. Metric history is kept, and registering
            <span class="mono">{{ removing.server.id }}</span> again restores it with a new key.</div>
        </div>
      </label>
      <label class="opt" :class="{ on: removing.mode === 'purge' }">
        <input type="radio" value="purge" v-model="removing.mode" />
        <div>
          <b>Erase permanently</b>
          <div class="muted">Deletes the registration, its keys, alert history and every stored sample.
            Cannot be undone.</div>
        </div>
      </label>
      <div class="row" style="justify-content: flex-end; margin-top: 4px">
        <button type="button" @click="removing = null">Cancel</button>
        <button class="danger" type="button" @click="confirmRemove">
          {{ removing.mode === 'purge' ? 'Erase permanently' : 'Remove' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.addcard {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 16px; margin-bottom: 12px;
}
.addhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.addhead h2 { margin: 0 0 3px; }
.addhead .sub { margin: 0; font-size: 12px; color: var(--ink-2); max-width: 68ch; line-height: 1.5; }
.addform {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start;
  margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--grid);
}
.addform .f { flex: 1; min-width: 190px; }
.addform .f.short { flex: 0 1 160px; min-width: 140px; }
.fh { display: block; font-size: 11px; color: var(--muted); margin-top: 3px; line-height: 1.4; }
.addactions { flex-basis: 100%; display: flex; justify-content: flex-end; gap: 8px; }
.warnline {
  flex-basis: 100%; margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--ink-2);
  background: color-mix(in oklab, var(--warning) 10%, transparent);
  border-left: 3px solid var(--warning); border-radius: 0 8px 8px 0; padding: 9px 12px;
}

.modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: grid; place-items: center; z-index: 40; }
.modal { width: 480px; max-width: 94vw; display: flex; flex-direction: column; gap: 10px; }
.acts { white-space: nowrap; }
.nowrap { white-space: nowrap; }
.notice {
  background: color-mix(in oklab, var(--accent) 8%, var(--surface));
  border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--border));
  border-radius: 10px; padding: 9px 12px; margin-bottom: 12px; font-size: 13px;
  display: flex; align-items: center; gap: 10px; justify-content: space-between;
}
.opt {
  display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; cursor: pointer;
}
.opt.on { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 6%, transparent); }
.opt input { width: auto; margin-top: 3px; }
.opt .muted { font-size: 12px; margin-top: 2px; }

/* Group chips double as filters, so the overview and the picker are one thing. */
.glist { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.gchip {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 6px 4px 12px;
  font-size: 12px; background: var(--surface); transition: border-color 0.12s ease, background 0.12s ease;
}
.gchip:hover { border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
.gchip.on { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 9%, transparent); }
.gchip .env { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.gchip .n {
  background: var(--grid); border-radius: 999px; padding: 0 7px;
  font-variant-numeric: tabular-nums; color: var(--ink-2);
}
.gchip.none b { color: var(--muted); font-weight: 600; }
.gchip .x {
  border: none; background: none; color: var(--muted); cursor: pointer;
  font-size: 15px; line-height: 1; padding: 0 4px; min-width: 0;
}
.gchip .x:hover { color: var(--critical); }

.bulk {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  background: color-mix(in oklab, var(--accent) 8%, var(--surface));
  border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--border));
  border-radius: 10px; padding: 8px 12px; margin: 10px 0; font-size: 13px;
}

tr.sel { background: color-mix(in oklab, var(--accent) 7%, transparent); }
.ginline { padding: 2px 6px; font-size: 12px; max-width: 170px; }
.ginline.unset { color: var(--muted); }
</style>
