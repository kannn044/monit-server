<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { api } from '../api.js';
import { fmtBytes, ago, fmtTime, fmtDuration } from '../util.js';
import Meter from '../components/Meter.vue';

const data = ref(null);
const error = ref('');
const projFilter = ref('');
const envFilter = ref('');
const search = ref('');
const sortBy = ref('health');
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

// Trouble first: a fleet view is for finding the box that needs attention.
const HEALTH_ORDER = { critical: 0, offline: 1, warning: 2, online: 3 };

const servers = computed(() => {
  let s = [...(data.value?.servers || [])];
  if (projFilter.value) s = s.filter((x) => x.projects.some((p) => p.id === projFilter.value));
  if (envFilter.value) s = s.filter((x) => x.projects.some((p) => p.environment === envFilter.value));
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase();
    s = s.filter((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  }
  const val = (x, k) => (x.current?.[k] ?? -1);
  s.sort((a, b) => {
    if (sortBy.value === 'health') {
      const d = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
      if (d) return d;
      return a.name.localeCompare(b.name);
    }
    if (sortBy.value === 'name') return a.name.localeCompare(b.name);
    return val(b, sortBy.value) - val(a, sortBy.value);
  });
  return s;
});

const counts = computed(() => data.value?.counts || {});
const attention = computed(() => (counts.value.critical || 0) + (counts.value.offline || 0));

const KPIS = [
  { key: 'total', label: 'Servers', tone: '' },
  { key: 'online', label: 'Online', tone: 'good' },
  { key: 'warning', label: 'Degraded', tone: 'warning' },
  { key: 'critical', label: 'Critical', tone: 'critical' },
  { key: 'offline', label: 'Offline', tone: 'offline' },
];

const diskSub = (c) =>
  c?.disk_avail_kb != null ? `${fmtBytes(c.disk_avail_kb * 1024)} free of ${fmtBytes((c.disk_size_kb || 0) * 1024)}` : '';
</script>

<template>
  <div class="row" style="justify-content: space-between; align-items: baseline">
    <h1 style="margin-bottom: 14px">Fleet</h1>
    <span v-if="data" class="muted" style="font-size: 12px">
      {{ attention ? `${attention} need attention` : 'all healthy' }} · updated {{ ago(new Date().toISOString()) }}
    </span>
  </div>
  <div v-if="error" class="error-banner">{{ error }}</div>

  <template v-if="data">
    <div class="kpis">
      <div v-for="k in KPIS" :key="k.key" class="stat" :class="{ hot: k.tone === 'critical' && counts[k.key] }">
        <div class="v" :class="k.tone">{{ counts[k.key] ?? 0 }}</div>
        <div class="l">{{ k.label }}</div>
      </div>
    </div>

    <div class="toolbar">
      <input v-model="search" placeholder="Search servers…" class="search" />
      <select v-model="projFilter">
        <option value="">All projects</option>
        <option v-for="p in data.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="envFilter">
        <option value="">All environments</option>
        <option v-for="e in envs" :key="e" :value="e">{{ e }}</option>
      </select>
      <div class="seg">
        <button v-for="s in [['health','Status'],['cpu','CPU'],['ram','RAM'],['disk','Disk'],['name','Name']]"
                :key="s[0]" :class="{ on: sortBy === s[0] }" @click="sortBy = s[0]">{{ s[1] }}</button>
      </div>
      <span class="muted" style="margin-left: auto; font-size: 12px">{{ servers.length }} shown</span>
    </div>

    <div class="cards">
      <router-link v-for="s in servers" :key="s.id" :to="`/servers/${s.id}`" class="cardlink">
        <article class="scard" :class="s.health">
          <header>
            <span class="dot" :class="s.health"></span>
            <span class="name" :title="s.name">{{ s.name }}</span>
            <span class="state" :class="s.health">{{ s.health }}</span>
          </header>

          <div class="meta">
            <span v-if="s.projects.length" class="tag">{{ s.projects[0].name }}</span>
            <span v-if="s.projects.length" class="env">{{ s.projects[0].environment }}</span>
            <span class="seen">{{ ago(s.last_seen) }}</span>
          </div>

          <div v-if="s.current" class="meters">
            <Meter label="CPU" :value="s.current.cpu" :warn="80" :crit="95" />
            <Meter label="RAM" :value="s.current.ram" :warn="80" :crit="90" />
            <Meter label="DISK" :value="s.current.disk" :warn="70" :crit="80" :sub="diskSub(s.current)" />
          </div>
          <div v-else class="nodata">
            {{ s.health === 'offline' ? 'no samples — agent not reporting' : 'waiting for first sample' }}
          </div>

          <footer v-if="s.current">
            <span>load {{ s.current.load_1m?.toFixed(2) ?? '—' }}<span v-if="s.current.cores"> / {{ s.current.cores }} cores</span></span>
            <span v-if="s.current.uptime_s">up {{ fmtDuration(s.current.uptime_s) }}</span>
          </footer>
        </article>
      </router-link>

      <div v-if="!servers.length" class="empty" style="grid-column: 1/-1">
        {{ data.servers.length ? 'No servers match the filters.' : 'No servers yet — register one in Projects.' }}
      </div>
    </div>

    <div class="grid two">
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

      <div class="card">
        <h2>Projects</h2>
        <table>
          <thead><tr><th>Project</th><th>Env</th><th class="num">Servers</th><th class="num">Critical</th></tr></thead>
          <tbody>
            <tr v-for="p in data.projects" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="muted">{{ p.environment }}</td>
              <td class="num">{{ p.server_count }}</td>
              <td class="num" :style="p.open_critical ? 'color: var(--critical); font-weight: 700' : ''">{{ p.open_critical }}</td>
            </tr>
            <tr v-if="!data.projects.length"><td colspan="4" class="empty">No projects.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>

<style scoped>
.stat .v.good { color: var(--good); }
.stat .v.warning { color: var(--warning); }
.stat .v.critical { color: var(--critical); }
.stat .v.offline { color: var(--offline); }
.stat.hot { border-color: color-mix(in oklab, var(--critical) 45%, transparent); }

.toolbar { display: flex; gap: 8px; align-items: center; margin: 16px 0 12px; flex-wrap: wrap; }
.search { min-width: 200px; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: 12px; margin-bottom: 16px; }
.cardlink { text-decoration: none; color: inherit; }
.cardlink:hover { text-decoration: none; }

.scard {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 13px 15px 12px; height: 100%;
  border-left: 4px solid var(--good);
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.scard:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.09); }
.scard.warning { border-left-color: var(--warning); }
.scard.critical { border-left-color: var(--critical); }
.scard.offline { border-left-color: var(--offline); }
.scard.offline .meters, .scard.offline .meta { opacity: 0.55; }

.scard header { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--good); }
.dot.warning { background: var(--warning); }
.dot.critical { background: var(--critical); }
.dot.offline { background: var(--offline); }
.name { font-weight: 650; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; }
.state.critical { color: var(--critical); }
.state.warning { color: var(--warning); }

.meta { display: flex; align-items: center; gap: 6px; margin-bottom: 11px; font-size: 11px; color: var(--muted); }
.tag { background: color-mix(in oklab, var(--accent) 11%, transparent); color: var(--ink-2); padding: 1px 7px; border-radius: 999px; }
.env { color: var(--muted); }
.seen { margin-left: auto; font-variant-numeric: tabular-nums; }

.meters { display: flex; flex-direction: column; gap: 9px; }
.nodata { color: var(--muted); font-size: 12px; padding: 14px 0; text-align: center; }

.scard footer {
  display: flex; justify-content: space-between; gap: 8px;
  margin-top: 11px; padding-top: 8px; border-top: 1px solid var(--grid);
  font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
}

.grid.two { grid-template-columns: 1.3fr 1fr; align-items: start; }
@media (max-width: 900px) { .grid.two { grid-template-columns: 1fr; } }
</style>
