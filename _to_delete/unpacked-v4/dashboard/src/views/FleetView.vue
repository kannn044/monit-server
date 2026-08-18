<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { api } from '../api.js';
import { fmt, ago, fmtTime } from '../util.js';
import TimeChart from '../components/TimeChart.vue';

const data = ref(null);
const error = ref('');
const projFilter = ref('');
const envFilter = ref('');
let timer;

async function load() {
  try {
    data.value = await api('/api/v1/fleet/health');
    error.value = '';
  } catch (e) { error.value = e.message; }
}
onMounted(() => { load(); timer = setInterval(load, 10_000); });
onUnmounted(() => clearInterval(timer));

const envs = computed(() => [...new Set((data.value?.projects || []).map((p) => p.environment))]);

const filteredServers = computed(() => {
  let s = data.value?.servers || [];
  if (projFilter.value) s = s.filter((x) => x.projects.some((p) => p.id === projFilter.value));
  if (envFilter.value) s = s.filter((x) => x.projects.some((p) => p.environment === envFilter.value));
  return s;
});

const spark = computed(() => {
  const sp = data.value?.sparkline_24h || [];
  return {
    'CPU %': sp.map((p) => ({ t: p.t, v: p.cpu })),
    'RAM %': sp.map((p) => ({ t: p.t, v: p.ram })),
    'Disk %': sp.map((p) => ({ t: p.t, v: p.disk })),
  };
});
</script>

<template>
  <h1>Fleet overview</h1>
  <div v-if="error" class="error-banner">{{ error }}</div>
  <template v-if="data">
    <div class="kpis">
      <div class="stat"><div class="v">{{ data.counts.total }}</div><div class="l">Total servers</div></div>
      <div class="stat"><div class="v" style="color: var(--good)">{{ data.counts.online }}</div><div class="l">Online</div></div>
      <div class="stat"><div class="v" style="color: var(--offline)">{{ data.counts.offline }}</div><div class="l">Offline</div></div>
      <div class="stat"><div class="v" style="color: var(--warning)">{{ data.counts.warning }}</div><div class="l">Degraded</div></div>
      <div class="stat"><div class="v" style="color: var(--critical)">{{ data.counts.critical }}</div><div class="l">Critical</div></div>
    </div>

    <div class="row" style="margin: 14px 0 10px">
      <select v-model="projFilter">
        <option value="">All projects</option>
        <option v-for="p in data.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="envFilter">
        <option value="">All environments</option>
        <option v-for="e in envs" :key="e" :value="e">{{ e }}</option>
      </select>
      <span class="muted">{{ filteredServers.length }} servers</span>
    </div>

    <div class="matrix" style="margin-bottom: 14px">
      <router-link v-for="s in filteredServers" :key="s.id" :to="`/servers/${s.id}`" style="text-decoration:none;color:inherit">
        <div class="cell" :class="s.health">
          <div class="n">{{ s.name }}</div>
          <div class="s">{{ s.health }} · {{ ago(s.last_seen) }}</div>
        </div>
      </router-link>
      <div v-if="!filteredServers.length" class="empty" style="grid-column: 1/-1">No servers yet — register one in Projects → or via API.</div>
    </div>

    <div class="grid" style="grid-template-columns: 1.35fr 1fr; align-items: start">
      <div class="grid">
        <div class="card">
          <h2>Fleet trend — last 24 h</h2>
          <TimeChart :series="spark" unit="percent" :y-max="100" :height="170" />
        </div>
        <div class="card">
          <h2>Recent alerts</h2>
          <table>
            <thead><tr><th>Severity</th><th>Rule</th><th>Server</th><th>Status</th><th>Started</th></tr></thead>
            <tbody>
              <tr v-for="i in data.ticker" :key="i.id">
                <td><span class="badge" :class="i.severity === 'critical' ? 'critical' : 'warning'">{{ i.severity }}</span></td>
                <td>{{ i.rule_name }}</td>
                <td><router-link :to="`/servers/${i.server_id}`">{{ i.server_id }}</router-link></td>
                <td><span class="badge" :class="i.status">{{ i.status }}</span></td>
                <td class="muted">{{ fmtTime(i.started_at) }}</td>
              </tr>
              <tr v-if="!data.ticker.length"><td colspan="5" class="empty">No alerts — all quiet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>Top usage (10 min avg)</h2>
        <table>
          <tbody>
            <tr v-for="row in [['CPU', 'cpu'], ['RAM', 'ram'], ['Disk', 'disk'], ['Load', 'load']]" :key="row[1]">
              <td style="width: 52px" class="muted">{{ row[0] }}</td>
              <td>
                <template v-if="data.top[row[1]].length">
                  <router-link v-for="t in data.top[row[1]]" :key="t.server_id" :to="`/servers/${t.server_id}`" style="margin-right: 12px">
                    {{ t.server_id }} <b>{{ row[1] === 'load' ? t.value.toFixed(2) : fmt(t.value, 'percent') }}</b>
                  </router-link>
                </template>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>

        <h2 style="margin-top: 16px">Projects</h2>
        <table>
          <thead><tr><th>Project</th><th>Env</th><th class="num">Servers</th><th class="num">Critical</th></tr></thead>
          <tbody>
            <tr v-for="p in data.projects" :key="p.id">
              <td>{{ p.name }}</td>
              <td><span class="muted">{{ p.environment }}</span></td>
              <td class="num">{{ p.server_count }}</td>
              <td class="num" :style="p.open_critical ? 'color: var(--critical); font-weight:700' : ''">{{ p.open_critical }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </template>
</template>
