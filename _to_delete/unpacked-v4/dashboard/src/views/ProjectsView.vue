<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';
import { ago } from '../util.js';
import { useAuth } from '../stores/auth.js';

const auth = useAuth();
const projects = ref([]);
const servers = ref([]);
const error = ref('');
const newProject = ref({ name: '', environment: 'Prod' });
const newServer = ref({ id: '', name: '', ip: '', project_ids: [] });
const issuedKey = ref(null);
const editingServer = ref(null);

async function load() {
  try {
    const [p, s] = await Promise.all([api('/api/v1/projects'), api('/api/v1/servers')]);
    projects.value = p.projects; servers.value = s.servers;
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
    issuedKey.value = { id: r.server.id, key: r.api_key };
    newServer.value = { id: '', name: '', ip: '', project_ids: [] };
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

async function delServer(s) {
  if (!confirm(`Archive server "${s.name}"? Its API key will be revoked.`)) return;
  await api(`/api/v1/servers/${s.id}`, { method: 'DELETE' });
  await load();
}
</script>

<template>
  <h1>Projects &amp; servers</h1>
  <div v-if="error" class="error-banner">{{ error }}</div>

  <div v-if="issuedKey" class="card" style="border-color: var(--warning); margin-bottom: 12px">
    <b>Agent key for {{ issuedKey.id }}</b> — shown once, copy it into <span class="mono">/etc/monit/agent.conf</span>:
    <div class="mono" style="margin-top: 6px; user-select: all">{{ issuedKey.key }}</div>
    <button class="sm" style="margin-top: 8px" @click="issuedKey = null">Dismiss</button>
  </div>

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
            <td class="mono muted">{{ s.id }}</td>
            <td class="muted">{{ s.projects.map((p) => p.name).join(', ') || '—' }}</td>
            <td><span class="badge" :class="s.health">{{ s.health }}</span></td>
            <td class="muted">{{ ago(s.last_seen) }}</td>
            <td>
              <template v-if="auth.isAdmin">
                <button class="sm" @click="editingServer = { ...s, project_ids: s.projects.map((p) => p.id), ip: s.ip || '' }">Edit</button>
                <button class="sm danger" @click="delServer(s)">Archive</button>
              </template>
            </td>
          </tr>
          <tr v-if="!servers.length"><td colspan="6" class="empty">No servers registered.</td></tr>
        </tbody>
      </table>

      <template v-if="auth.isAdmin">
        <h2 style="margin-top: 16px">Register a server</h2>
        <form class="row" @submit.prevent="createServer">
          <input v-model="newServer.id" placeholder="server_id (e.g. web-prod-01)" required pattern="[A-Za-z0-9._-]+" style="flex: 1" />
          <input v-model="newServer.name" placeholder="Display name" required style="flex: 1" />
          <input v-model="newServer.ip" placeholder="IP (optional)" style="width: 130px" />
          <select v-model="newServer.project_ids" multiple size="1" style="width: 160px">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <button class="primary" type="submit">Register</button>
        </form>
        <p class="muted" style="font-size: 12px">The <span class="mono">server_id</span> must match <span class="mono">MONIT_SERVER_ID</span> in the agent config.</p>
      </template>
    </div>
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
</template>

<style scoped>
.modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: grid; place-items: center; z-index: 40; }
.modal { width: 480px; max-width: 94vw; display: flex; flex-direction: column; gap: 10px; }
</style>
