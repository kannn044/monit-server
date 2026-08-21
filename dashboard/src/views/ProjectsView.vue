<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import { ago } from '../util.js';
import { useAuth } from '../stores/auth.js';
import AgentKey from '../components/AgentKey.vue';

const auth = useAuth();
const projects = ref([]);
const servers = ref([]);
const archived = ref([]);
const error = ref('');
const notice = ref('');
const newProject = ref({ name: '', environment: 'Prod' });
const newServer = ref({ id: '', name: '', ip: '', project_ids: [] });
const issuedKey = ref(null);
const editingServer = ref(null);
const removing = ref(null);   // server pending deletion + chosen mode

async function load() {
  try {
    const [p, s, a] = await Promise.all([
      api('/api/v1/projects'),
      api('/api/v1/servers'),
      api('/api/v1/servers?archived=only'),
    ]);
    projects.value = p.projects; servers.value = s.servers; archived.value = a.servers;
    error.value = '';
  } catch (e) { error.value = e.message; }
}
onMounted(load);

async function createProject() {
  try {
    await api('/api/v1/projects', { method: 'POST', body: newProject.value });
    newProject.value = { name: '', environment: 'Prod' };
    await load();
  } catch (e) { error.value = e.message; }
}

async function delProject(p) {
  if (!confirm(`Archive project "${p.name}"?`)) return;
  await api(`/api/v1/projects/${p.id}`, { method: 'DELETE' });
  await load();
}

async function createServer() {
  try {
    const r = await api('/api/v1/servers', { method: 'POST', body: newServer.value });
    issuedKey.value = {
      id: r.server.id,
      key: r.api_key,
      title: r.revived ? 'Server restored — new agent key' : 'Agent key',
    };
    notice.value = r.revived
      ? `"${r.server.id}" was previously deleted; its registration has been restored and a new key issued.`
      : '';
    newServer.value = { id: '', name: '', ip: '', project_ids: [] };
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}

async function saveServer() {
  const s = editingServer.value;
  try {
    await api(`/api/v1/servers/${s.id}`, {
      method: 'PATCH',
      body: { name: s.name, ip: s.ip || undefined, project_ids: s.project_ids },
    });
    editingServer.value = null;
    await load();
  } catch (e) { error.value = e.message; }
}

// Keys are stored as SHA-256 hashes, so a forgotten key cannot be looked up —
// issuing a replacement is the only recovery, and it is one click from the list.
async function newKey(s) {
  if (!confirm(`Issue a new agent key for "${s.name}"?\n\nThe current key stops working immediately — the agent will not report again until the new key is installed on that host.`)) return;
  try {
    const r = await api(`/api/v1/servers/${s.id}/keys/rotate`, { method: 'POST' });
    issuedKey.value = { id: s.id, key: r.api_key, title: 'New agent key' };
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
    issuedKey.value = { id: s.id, key: r.api_key, title: 'Server restored — new agent key' };
    notice.value = '';
    error.value = '';
    await load();
  } catch (e) { error.value = e.message; }
}
</script>

<template>
  <h1>Projects &amp; servers</h1>
  <div v-if="error" class="error-banner">{{ error }}</div>
  <div v-if="notice" class="notice">{{ notice }} <button class="sm" @click="notice = ''">Dismiss</button></div>

  <AgentKey v-if="issuedKey" :server-id="issuedKey.id" :api-key="issuedKey.key" :title="issuedKey.title"
            @dismiss="issuedKey = null" />

  <div class="grid" style="grid-template-columns: 1fr 1.4fr; align-items: start">
    <div class="card">
      <h2>Projects</h2>
      <table>
        <thead><tr><th>Name</th><th>Environment</th><th class="num">Servers</th><th></th></tr></thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id">
            <td><b>{{ p.name }}</b></td>
            <td class="muted">{{ p.environment }}</td>
            <td class="num">{{ p.server_count }}</td>
            <td><button v-if="auth.isAdmin" class="sm danger" @click="delProject(p)">Archive</button></td>
          </tr>
          <tr v-if="!projects.length"><td colspan="4" class="empty">No projects yet.</td></tr>
        </tbody>
      </table>

      <form v-if="auth.isAdmin" class="row" style="margin-top: 12px" @submit.prevent="createProject">
        <input v-model="newProject.name" placeholder="Project name" required style="flex: 1" />
        <input v-model="newProject.environment" placeholder="Prod" style="width: 90px" />
        <button class="primary" type="submit">Add</button>
      </form>
    </div>

    <div class="card">
      <h2>Servers</h2>
      <table>
        <thead><tr><th>Name</th><th>ID</th><th>Projects</th><th>Health</th><th>Last seen</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in servers" :key="s.id">
            <td><router-link :to="`/servers/${s.id}`">{{ s.name }}</router-link></td>
            <td class="mono muted nowrap">{{ s.id }}</td>
            <td class="muted">{{ s.projects.map((p) => p.name).join(', ') || '—' }}</td>
            <td><span class="badge" :class="s.health">{{ s.health }}</span></td>
            <td class="muted">{{ ago(s.last_seen) }}</td>
            <td class="acts">
              <template v-if="auth.isAdmin">
                <button class="sm" @click="editingServer = { ...s, project_ids: s.projects.map((p) => p.id), ip: s.ip || '' }">Edit</button>
                <button class="sm" title="Issue a replacement key — forgotten keys cannot be looked up" @click="newKey(s)">New key</button>
                <button class="sm danger" @click="removing = { server: s, mode: 'archive' }">Delete</button>
              </template>
            </td>
          </tr>
          <tr v-if="!servers.length"><td colspan="6" class="empty">No servers registered.</td></tr>
        </tbody>
      </table>

      <template v-if="auth.isAdmin">
        <h2 style="margin-top: 16px">Register a server</h2>
        <form class="row" @submit.prevent="createServer">
          <input v-model="newServer.id" placeholder="server_id (e.g. web-prod-01)" required pattern="[A-Za-z0-9._\-]+" style="flex: 1" />
          <input v-model="newServer.name" placeholder="Display name" required style="flex: 1" />
          <input v-model="newServer.ip" placeholder="IP (optional)" style="width: 130px" />
          <select v-model="newServer.project_ids" multiple size="1" style="width: 160px">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <button class="primary" type="submit">Register</button>
        </form>
        <p class="muted" style="font-size: 12px">
          The <span class="mono">server_id</span> must match <span class="mono">MONIT_SERVER_ID</span> in the agent config.
          Reusing the ID of a deleted server restores it and issues a new key.
        </p>
      </template>
    </div>
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
          <td class="mono muted nowrap">{{ s.id }}</td>
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
      <label class="f">Projects
        <select v-model="editingServer.project_ids" multiple size="5">
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }} ({{ p.environment }})</option>
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
</style>
