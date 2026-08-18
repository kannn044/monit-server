<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';
import { fmtDuration, fmtTime } from '../util.js';
import { useAuth } from '../stores/auth.js';

const auth = useAuth();
const incidents = ref([]);
const projects = ref([]);
const filters = ref({ status: '', severity: '', project: '', from: '', to: '' });
const error = ref('');
const busy = ref('');

async function load() {
  const qs = Object.entries(filters.value).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try {
    const r = await api(`/api/v1/incidents?limit=200${qs ? '&' + qs : ''}`);
    incidents.value = r.incidents;
    error.value = '';
  } catch (e) { error.value = e.message; }
}

async function act(id, what, extra) {
  busy.value = id;
  try {
    await api(`/api/v1/alerts/${id}/${what}`, { method: 'POST', body: extra || {} });
    await load();
  } catch (e) { error.value = e.message; } finally { busy.value = ''; }
}

async function silence(id) {
  const m = prompt('Silence for how many minutes?', '60');
  if (m) await act(id, 'silence', { minutes: Number(m) });
}

onMounted(async () => {
  await load();
  projects.value = (await api('/api/v1/projects')).projects;
});

const open = computed(() => incidents.value.filter((i) => ['firing', 'acknowledged', 'flapping', 'silenced'].includes(i.status)));
const past = computed(() => incidents.value.filter((i) => i.status === 'resolved'));
</script>

<template>
  <h1>Incidents</h1>
  <div v-if="error" class="error-banner">{{ error }}</div>

  <div class="row" style="margin-bottom: 12px">
    <select v-model="filters.status" @change="load"><option value="">Any status</option>
      <option v-for="s in ['firing','acknowledged','resolved','flapping','silenced']" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="filters.severity" @change="load"><option value="">Any severity</option>
      <option v-for="s in ['critical','warning','info']" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="filters.project" @change="load"><option value="">Any project</option>
      <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <label class="f">From <input v-model="filters.from" type="date" @change="load" /></label>
    <label class="f">To <input v-model="filters.to" type="date" @change="load" /></label>
  </div>

  <div class="card" style="margin-bottom: 12px">
    <h2>Active ({{ open.length }})</h2>
    <table>
      <thead><tr>
        <th>Severity</th><th>Rule</th><th>Server</th><th>Metric</th><th class="num">Value</th>
        <th class="num">Threshold</th><th>Since</th><th>Duration</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        <tr v-for="i in open" :key="i.id">
          <td><span class="badge" :class="i.severity === 'critical' ? 'critical' : 'warning'">{{ i.severity }}</span></td>
          <td>{{ i.rule_name }}</td>
          <td><router-link :to="`/servers/${i.server_id}`">{{ i.server_name || i.server_id }}</router-link></td>
          <td class="mono">{{ i.metric }}</td>
          <td class="num">{{ i.value === null ? '—' : Number(i.value).toFixed(2) }}</td>
          <td class="num muted">{{ i.threshold ?? '—' }}</td>
          <td class="muted">{{ fmtTime(i.started_at) }}</td>
          <td class="muted">{{ fmtDuration((Date.now() - new Date(i.started_at)) / 1000) }}</td>
          <td><span class="badge" :class="i.status">{{ i.status }}</span></td>
          <td>
            <template v-if="auth.isOperator">
              <button class="sm" :disabled="busy === i.id" @click="act(i.id, 'ack')">Ack</button>
              <button class="sm" :disabled="busy === i.id" @click="act(i.id, 'resolve')">Resolve</button>
              <button class="sm" :disabled="busy === i.id" @click="silence(i.id)">Silence</button>
            </template>
          </td>
        </tr>
        <tr v-if="!open.length"><td colspan="10" class="empty">No active incidents.</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>History ({{ past.length }})</h2>
    <table>
      <thead><tr><th>Severity</th><th>Rule</th><th>Server</th><th>Metric</th><th>Started</th><th>Resolved</th><th>Duration</th></tr></thead>
      <tbody>
        <tr v-for="i in past" :key="i.id">
          <td><span class="badge" :class="i.severity === 'critical' ? 'critical' : 'warning'">{{ i.severity }}</span></td>
          <td>{{ i.rule_name }}</td>
          <td><router-link :to="`/servers/${i.server_id}`">{{ i.server_name || i.server_id }}</router-link></td>
          <td class="mono">{{ i.metric }}</td>
          <td class="muted">{{ fmtTime(i.started_at) }}</td>
          <td class="muted">{{ i.resolved_at ? fmtTime(i.resolved_at) : '—' }}</td>
          <td class="muted">{{ fmtDuration((new Date(i.resolved_at) - new Date(i.started_at)) / 1000) }}</td>
        </tr>
        <tr v-if="!past.length"><td colspan="7" class="empty">No resolved incidents in range.</td></tr>
      </tbody>
    </table>
  </div>
</template>
