<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { fmt, fmtBytes, fmtDuration, ago, fmtTime, RANGES } from '../util.js';
import { useAuth } from '../stores/auth.js';
import TimeChart from '../components/TimeChart.vue';
import AgentKey from '../components/AgentKey.vue';
import Meter from '../components/Meter.vue';

const route = useRoute();
const auth = useAuth();
const id = computed(() => route.params.id);

const info = ref(null);
const summary = ref(null);
const incidents = ref([]);
const range = ref(RANGES[1]); // 1h
const charts = ref({}); // kind → series
const loadingCharts = ref(false);
const newKey = ref('');
const error = ref('');
let timer;

const kinds = ['cpu', 'ram', 'disk', 'net', 'load', 'gpu', 'gpuvram'];
// Each chart holds ONE unit — % and GB never share an axis.
const kindMeta = {
  cpu: { title: 'CPU %', unit: 'percent', yMax: 100, ensemble: 'core ' },
  ram: { title: 'Memory (GB)', unit: '', yMax: null },
  disk: { title: 'Disk used % (per mount)', unit: 'percent', yMax: 100 },
  net: { title: 'Network I/O', unit: 'bytes/s', yMax: null },
  load: { title: 'Load average vs. core count', unit: '', yMax: null },
  gpu: { title: 'GPU utilization %', unit: 'percent', yMax: 100 },
  gpuvram: { title: 'GPU VRAM used %', unit: 'percent', yMax: 100 },
};

async function loadInfo() {
  try {
    const [i, s, inc] = await Promise.all([
      api(`/api/v1/servers/${id.value}`),
      api(`/api/v1/servers/${id.value}/summary`),
      api(`/api/v1/incidents?server=${id.value}&limit=20`),
    ]);
    info.value = i; summary.value = s.summary; incidents.value = inc.incidents;
    error.value = '';
  } catch (e) { error.value = e.message; }
}

async function loadCharts() {
  loadingCharts.value = true;
  const to = new Date();
  const from = new Date(to.getTime() - range.value.ms);
  const qs = `from=${from.toISOString()}&to=${to.toISOString()}`;
  try {
    const results = await Promise.all(kinds.map((k) => api(`/api/v1/servers/${id.value}/series?kind=${k}&${qs}`)));
    const out = {};
    kinds.forEach((k, idx) => { out[k] = results[idx].series; });
    charts.value = out;
  } catch (e) { error.value = e.message; }
  loadingCharts.value = false;
}

// There is no "show me the key again" — only its SHA-256 hash is stored. A
// forgotten key is replaced, not recovered.
async function rotateKey() {
  if (!confirm('Issue a new agent key?\n\nThe current key stops working immediately — the agent will not report again until the new key is installed on that host.')) return;
  try {
    const r = await api(`/api/v1/servers/${id.value}/keys/rotate`, { method: 'POST' });
    newKey.value = r.api_key;
  } catch (e) { error.value = e.message; }
}

// `databases` also carries the NDB cluster block, which is rendered on its own
// above and has no connection-pool shape — keep it out of this table.
const connDatabases = computed(() => Object.fromEntries(
  Object.entries(summary.value?.databases || {}).filter(([, d]) => d && d.reachable !== undefined)));

const hasGpu = computed(() => Object.keys(charts.value.gpu || {}).length > 0 || (summary.value?.gpu || []).length > 0);
const visibleKinds = computed(() => kinds.filter((k) => !k.startsWith('gpu') || hasGpu.value));

onMounted(() => {
  loadInfo(); loadCharts();
  timer = setInterval(() => { loadInfo(); if (range.value.ms <= 3600e3) loadCharts(); }, 10_000);
});
onUnmounted(() => clearInterval(timer));
watch(range, loadCharts);
watch(id, () => { info.value = null; charts.value = {}; loadInfo(); loadCharts(); });
</script>

<template>
  <div v-if="error" class="error-banner">{{ error }}</div>
  <template v-if="info">
    <div class="row" style="justify-content: space-between; margin-bottom: 12px">
      <div>
        <h1 style="margin-bottom: 4px">
          {{ info.server.name }}
          <span class="badge" :class="info.server.health" style="vertical-align: 3px">{{ info.server.health }}</span>
        </h1>
        <div class="muted">
          {{ info.server.id }} · {{ info.server.os || 'unknown OS' }}
          <span v-if="info.server.ip"> · {{ info.server.ip }}</span>
          · last seen {{ ago(info.server.last_seen) }}
          <span v-if="summary"> · up {{ fmtDuration(summary.uptime_s) }}</span>
          <template v-for="p in info.server.projects" :key="p.id"> · <b>{{ p.name }}</b> ({{ p.environment }})</template>
        </div>
      </div>
      <div class="row">
        <div class="seg">
          <button v-for="r in RANGES" :key="r.label" :class="{ on: range.label === r.label }" @click="range = r">{{ r.label }}</button>
        </div>
        <button v-if="auth.isAdmin" class="sm" title="Issue a replacement key — forgotten keys cannot be looked up" @click="rotateKey">New key</button>
      </div>
    </div>

    <AgentKey v-if="newKey" :server-id="info.server.id" :api-key="newKey" title="New agent key"
              @dismiss="newKey = ''" />

    <div v-if="summary" class="kpis" style="margin-bottom: 12px">
      <div class="stat"><div class="v">{{ fmt(summary.cpu_total, 'percent') }}</div><div class="l">CPU</div></div>
      <div class="stat"><div class="v">{{ fmt(summary.ram_used_pct, 'percent') }}</div><div class="l">RAM used</div></div>
      <div class="stat"><div class="v">{{ fmt(summary.disk_used_pct, 'percent') }}</div><div class="l">Disk (worst mount)</div></div>
      <div class="stat"><div class="v">{{ summary.net ? fmt(summary.net.rx_bps, 'bytes/s') : '—' }}</div><div class="l">Net RX</div></div>
      <div class="stat"><div class="v">{{ summary.net ? fmt(summary.net.tx_bps, 'bytes/s') : '—' }}</div><div class="l">Net TX</div></div>
      <div class="stat"><div class="v">{{ fmt(summary.load_1m) }}</div><div class="l">Load 1m</div></div>
      <div v-if="summary.gpu_util_pct !== null" class="stat"><div class="v">{{ fmt(summary.gpu_util_pct, 'percent') }}</div><div class="l">GPU util</div></div>
      <div v-if="summary.gpu_mem_used_pct !== null" class="stat"><div class="v">{{ fmt(summary.gpu_mem_used_pct, 'percent') }}</div><div class="l">VRAM used</div></div>
    </div>

    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(420px, 1fr))">
      <div v-for="k in visibleKinds" :key="k" class="card">
        <h2>{{ kindMeta[k].title }}</h2>
        <TimeChart :series="charts[k] || {}" :unit="kindMeta[k].unit" :y-max="kindMeta[k].yMax"
                   :ensemble-prefix="kindMeta[k].ensemble || ''" :height="180" :loading="loadingCharts" />
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 1fr 1fr; margin-top: 12px; align-items: start">
      <div class="card" v-if="summary">
        <h2>Application health</h2>
        <template v-if="summary.docker?.present">
          <h3 class="muted" style="font-size: 12px; margin: 8px 0 4px">
            Docker — <template v-if="summary.docker.accessible === false">not readable</template>
            <template v-else>{{ summary.docker.running }}/{{ summary.docker.total }} running</template>
          </h3>
          <div v-if="summary.docker.accessible === false" class="unreadable">
            The agent cannot reach the Docker daemon, so container state is unknown — it is not being
            reported as down.<span v-if="summary.docker.reason" class="mono"> {{ summary.docker.reason }}</span>
          </div>
          <table>
            <tbody>
              <tr v-for="c in (summary.docker.containers || []).slice(0, 20)" :key="c.name">
                <td>{{ c.name }}</td>
                <td><span class="badge" :class="c.state === 'running' ? 'online' : 'critical'">{{ c.state }}</span></td>
                <td class="muted">{{ c.status }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <template v-if="summary.pm2?.present">
          <h3 class="muted" style="font-size: 12px; margin: 12px 0 4px">
            PM2 —
            <template v-if="summary.pm2.accessible === false">not readable</template>
            <template v-else>{{ summary.pm2.online }} online / {{ summary.pm2.stopped }} stopped</template>
          </h3>
          <!-- PM2's daemon is per-user and only answers its owner, so an agent
               running as 'monit' reaches an empty daemon of its own. Say that,
               rather than publishing a zero we never actually measured. -->
          <div v-if="summary.pm2.accessible === false" class="unreadable">
            A PM2 daemon is running<span v-if="summary.pm2.owners?.length"> (owner:
            <b>{{ summary.pm2.owners.join(', ') }}</b>)</span> but the agent cannot read it, so process
            state is unknown — it is not being reported as down.
            <div v-if="summary.pm2.reason" class="fix">Fix: <span class="mono">{{ summary.pm2.reason }}</span></div>
          </div>
          <table>
            <tbody>
              <tr v-for="p in (summary.pm2.processes || []).slice(0, 20)" :key="p.name">
                <td>{{ p.name }}</td>
                <td><span class="badge" :class="p.status === 'online' ? 'online' : 'critical'">{{ p.status }}</span></td>
                <td class="muted num">{{ p.memory ? fmtBytes(p.memory) : '' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <!-- MySQL NDB Cluster. A data node that is down disappears from
             ndbinfo entirely, so the agent compares the configured roster
             against the live one; "MISSING" below is a node that should be
             there and is not. -->
        <template v-if="summary.databases?.ndb?.present">
          <h3 class="muted" style="font-size: 12px; margin: 12px 0 4px">
            NDB Cluster —
            <template v-if="summary.databases.ndb.accessible === false">not readable</template>
            <template v-else>
              {{ summary.databases.ndb.data_nodes_started }}/{{ summary.databases.ndb.data_nodes_configured }} data nodes started
            </template>
          </h3>
          <div v-if="summary.databases.ndb.accessible === false" class="unreadable">
            An NDB cluster is configured but the agent cannot read it, so node state is unknown —
            nothing is being reported as down.
            <div v-if="summary.databases.ndb.reason" class="fix">{{ summary.databases.ndb.reason }}</div>
          </div>
          <template v-else>
            <div class="ndbstats">
              <span :class="{ bad: summary.databases.ndb.unhealthy > 0 }">
                {{ summary.databases.ndb.unhealthy }} not started
              </span>
              <span v-if="summary.databases.ndb.node_groups_total !== undefined"
                    :class="{ bad: summary.databases.ndb.node_groups_down > 0 }">
                {{ summary.databases.ndb.node_groups_down }}/{{ summary.databases.ndb.node_groups_total }} node groups down
              </span>
              <span v-else class="muted" title="A node that is not connected does not report its node group">
                node groups unknown
              </span>
              <span v-if="summary.databases.ndb.arbitrator_connected === false" class="bad">arbitrator lost</span>
            </div>
            <div v-if="summary.databases.ndb.data_memory_pct != null" class="meters ndbmem">
              <Meter label="DATA MEMORY" :value="summary.databases.ndb.data_memory_pct" :warn="75" :crit="85" />
              <Meter v-if="summary.databases.ndb.index_memory_pct != null"
                     label="INDEX MEMORY" :value="summary.databases.ndb.index_memory_pct" :warn="75" :crit="85" />
            </div>
            <table>
              <tbody>
                <tr v-for="n in (summary.databases.ndb.nodes || [])" :key="n.id">
                  <td class="mono">id={{ n.id }}</td>
                  <td class="muted">{{ n.type }}</td>
                  <td class="mono muted">{{ n.host || '—' }}</td>
                  <td>
                    <span class="badge" :class="n.status === 'STARTED' || n.status === 'CONNECTED' ? 'online'
                          : n.status === 'STARTING' ? 'warning' : 'critical'">{{ n.status }}</span>
                  </td>
                  <td class="muted">{{ n.group !== undefined ? `nodegroup ${n.group}` : '' }}</td>
                  <td class="muted num">{{ n.uptime_s ? fmtDuration(n.uptime_s) : '' }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>

        <template v-if="(summary.http || []).length">
          <h3 class="muted" style="font-size: 12px; margin: 12px 0 4px">HTTP checks</h3>
          <table>
            <tbody>
              <tr v-for="h in summary.http" :key="h.url">
                <td class="mono">{{ h.url }}</td>
                <td><span class="badge" :class="h.status_code === 200 ? 'online' : 'critical'">{{ h.status_code || 'down' }}</span></td>
                <td class="num muted">{{ h.latency_ms }} ms</td>
              </tr>
            </tbody>
          </table>
        </template>
        <template v-if="Object.keys(connDatabases).length">
          <h3 class="muted" style="font-size: 12px; margin: 12px 0 4px">Databases</h3>
          <table>
            <tbody>
              <tr v-for="(d, name) in connDatabases" :key="name">
                <td>{{ name }}</td>
                <td><span class="badge" :class="d.reachable ? 'online' : 'critical'">{{ d.reachable ? 'up' : 'down' }}</span></td>
                <td class="num muted">{{ d.active }}/{{ d.max }} active</td>
              </tr>
            </tbody>
          </table>
        </template>
        <div v-if="!summary.docker?.present && !summary.pm2?.present && !summary.databases?.ndb?.present && !(summary.http || []).length" class="empty">
          No app-level checks reported by the agent.
        </div>

        <template v-if="info.expected_services?.length">
          <h3 class="muted" style="font-size: 12px; margin: 12px 0 4px">Expected services</h3>
          <div class="row">
            <span v-for="e in info.expected_services" :key="e.id" class="badge online">{{ e.kind }}: {{ e.name }}</span>
          </div>
        </template>
      </div>

      <div class="card">
        <h2>Incident history</h2>
        <table>
          <thead><tr><th>Severity</th><th>Rule</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>
          <tbody>
            <tr v-for="i in incidents" :key="i.id">
              <td><span class="badge" :class="i.severity === 'critical' ? 'critical' : 'warning'">{{ i.severity }}</span></td>
              <td>{{ i.rule_name }}</td>
              <td><span class="badge" :class="i.status">{{ i.status }}</span></td>
              <td class="muted">{{ fmtTime(i.started_at) }}</td>
              <td class="muted">{{ fmtDuration(((i.resolved_at ? new Date(i.resolved_at) : new Date()) - new Date(i.started_at)) / 1000) }}</td>
            </tr>
            <tr v-if="!incidents.length"><td colspan="5" class="empty">No incidents recorded.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>

<style scoped>
.unreadable {
  font-size: 12px; color: var(--ink-2); line-height: 1.5;
  background: color-mix(in oklab, var(--warning) 9%, transparent);
  border-left: 3px solid var(--warning); border-radius: 0 8px 8px 0;
  padding: 8px 11px; margin: 4px 0 8px;
}
.unreadable .fix { margin-top: 4px; color: var(--muted); }
.ndbstats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); margin: 2px 0 8px; }
.ndbstats .bad { color: var(--critical); font-weight: 650; }
.meters.ndbmem { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 10px; max-width: 420px; }
</style>
