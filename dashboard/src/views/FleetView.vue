<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { api } from '../api.js';
import { fmtBytes, ago, fmtTime } from '../util.js';
import Meter from '../components/Meter.vue';

const data = ref(null);
const error = ref('');
const groupFilter = ref('');
const envFilter = ref('');
const search = ref('');
const sortBy = ref('health');
const troubleOnly = ref(false);
const layout = ref(pref('layout', 'cards', ['cards', 'rows']));
const groupBy = ref(pref('groupby', 'group', ['group', 'env', 'none']));
const collapsed = ref(new Set(readCollapsed()));
let timer;

// Small helpers around localStorage: a private window or a browser with site
// data blocked throws on access, and the page must still render.
function pref(key, fallback, allowed) {
  try {
    const v = localStorage.getItem(`monit.fleet.${key}`);
    return allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}
function save(key, v) { try { localStorage.setItem(`monit.fleet.${key}`, v); } catch { /* ignore */ } }
function readCollapsed() {
  try { return JSON.parse(localStorage.getItem('monit.fleet.collapsed') || '[]'); } catch { return []; }
}
function toggleGroup(key) {
  const next = new Set(collapsed.value);
  next.has(key) ? next.delete(key) : next.add(key);
  collapsed.value = next;
  try { localStorage.setItem('monit.fleet.collapsed', JSON.stringify([...next])); } catch { /* ignore */ }
}
const setLayout = (v) => { layout.value = v; save('layout', v); };
const setGroupBy = (v) => { groupBy.value = v; save('groupby', v); };

async function load() {
  try {
    data.value = await api('/api/v1/fleet/health');
    error.value = '';
  } catch (e) { error.value = e.message; }
}
onMounted(() => { load(); timer = setInterval(load, 10_000); });
onUnmounted(() => clearInterval(timer));

const groups = computed(() => data.value?.projects || []);
const envs = computed(() => [...new Set(groups.value.map((p) => p.environment))]);

// Trouble first: a fleet view is for finding the box that needs attention.
const HEALTH_ORDER = { critical: 0, offline: 1, warning: 2, online: 3 };

// The thresholds a card is judged against — the same numbers the seeded alert
// rules use, so a red bar here means a rule is about to fire.
const LIMITS = { cpu: [80, 95], ram: [80, 90], disk: [70, 80] };
const level = (v, [warn, crit]) => (v == null ? 'none' : v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');

// One group per server by design; the first membership is the one that counts.
const groupOf = (s) => s.projects?.[0] || null;

const filtered = computed(() => {
  let s = [...(data.value?.servers || [])];
  if (groupFilter.value) {
    s = groupFilter.value === '__none'
      ? s.filter((x) => !groupOf(x))
      : s.filter((x) => groupOf(x)?.id === groupFilter.value);
  }
  if (envFilter.value) s = s.filter((x) => groupOf(x)?.environment === envFilter.value);
  if (troubleOnly.value) s = s.filter((x) => x.health !== 'online');
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase();
    s = s.filter((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  }
  const val = (x, k) => (x.current?.[k] ?? -1);
  s.sort((a, b) => {
    if (sortBy.value === 'health') {
      const d = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
      return d || a.name.localeCompare(b.name);
    }
    if (sortBy.value === 'name') return a.name.localeCompare(b.name);
    return val(b, sortBy.value) - val(a, sortBy.value);
  });
  return s;
});

// Sections, each with its own health tally so a collapsed group still says
// whether anything inside it is on fire.
const sections = computed(() => {
  const list = filtered.value;
  if (groupBy.value === 'none') return [{ key: '__all', label: '', servers: list, hideHeader: true }];

  const buckets = new Map();
  const keyOf = (s) => {
    const g = groupOf(s);
    if (groupBy.value === 'env') return g ? `env:${g.environment}` : '__none';
    return g ? `grp:${g.id}` : '__none';
  };
  const labelOf = (s) => {
    const g = groupOf(s);
    if (!g) return 'Ungrouped';
    return groupBy.value === 'env' ? g.environment : g.name;
  };
  for (const s of list) {
    const k = keyOf(s);
    if (!buckets.has(k)) buckets.set(k, { key: k, label: labelOf(s), env: groupOf(s)?.environment || '', servers: [] });
    buckets.get(k).servers.push(s);
  }
  const out = [...buckets.values()].map((b) => {
    const tally = { critical: 0, offline: 0, warning: 0, online: 0 };
    for (const s of b.servers) tally[s.health] = (tally[s.health] || 0) + 1;
    return { ...b, tally, attention: tally.critical + tally.offline + tally.warning };
  });
  // Groups needing attention first, then alphabetically; Ungrouped always last.
  out.sort((a, b) => {
    if (a.key === '__none') return 1;
    if (b.key === '__none') return -1;
    return (b.attention - a.attention) || a.label.localeCompare(b.label);
  });
  return out;
});

const counts = computed(() => data.value?.counts || {});
const attention = computed(() => (counts.value.critical || 0) + (counts.value.offline || 0));
const shown = computed(() => filtered.value.length);

const KPIS = [
  { key: 'total', label: 'Servers', tone: '' },
  { key: 'online', label: 'Online', tone: 'good' },
  { key: 'warning', label: 'Degraded', tone: 'warning' },
  { key: 'critical', label: 'Critical', tone: 'critical' },
  { key: 'offline', label: 'Offline', tone: 'offline' },
];

const diskFree = (c) => (c?.disk_avail_kb != null ? `${fmtBytes(c.disk_avail_kb * 1024)} free` : '');
const pct = (v) => (v == null ? '—' : `${v.toFixed(0)}%`);
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
      <select v-model="groupFilter">
        <option value="">All groups</option>
        <option v-for="p in groups" :key="p.id" :value="p.id">{{ p.name }}</option>
        <option value="__none">Ungrouped</option>
      </select>
      <select v-model="envFilter">
        <option value="">All environments</option>
        <option v-for="e in envs" :key="e" :value="e">{{ e }}</option>
      </select>
      <label class="chk" title="Hide servers that are online and within every threshold">
        <input v-model="troubleOnly" type="checkbox" /> Needs attention
      </label>
      <div class="seg" title="Group servers by">
        <button v-for="g in [['group','Group'],['env','Env'],['none','Flat']]" :key="g[0]"
                :class="{ on: groupBy === g[0] }" @click="setGroupBy(g[0])">{{ g[1] }}</button>
      </div>
      <div class="seg">
        <button v-for="s in [['health','Status'],['cpu','CPU'],['ram','RAM'],['disk','Disk'],['name','Name']]"
                :key="s[0]" :class="{ on: sortBy === s[0] }" @click="sortBy = s[0]">{{ s[1] }}</button>
      </div>
      <div class="seg">
        <button :class="{ on: layout === 'cards' }" @click="setLayout('cards')">Cards</button>
        <button :class="{ on: layout === 'rows' }" @click="setLayout('rows')">Rows</button>
      </div>
      <span class="muted" style="margin-left: auto; font-size: 12px">{{ shown }} shown</span>
    </div>

    <div v-if="!shown" class="card empty" style="margin-bottom: 16px">
      {{ troubleOnly && data.servers.length ? 'Nothing needs attention.'
         : data.servers.length ? 'No servers match the filters.' : 'No servers yet — register one in Groups.' }}
    </div>

    <section v-for="sec in sections" :key="sec.key" class="gsec">
      <!-- The tally stays visible when the section is collapsed, so folding a
           group away never hides a fire inside it. -->
      <header v-if="!sec.hideHeader" class="ghead" @click="toggleGroup(sec.key)">
        <span class="caret" :class="{ open: !collapsed.has(sec.key) }">▸</span>
        <span class="glabel">{{ sec.label }}</span>
        <span v-if="sec.env && groupBy === 'group'" class="genv">{{ sec.env }}</span>
        <span class="gcount">{{ sec.servers.length }}</span>
        <span class="tally">
          <span v-if="sec.tally.critical" class="t crit">{{ sec.tally.critical }} critical</span>
          <span v-if="sec.tally.offline" class="t off">{{ sec.tally.offline }} offline</span>
          <span v-if="sec.tally.warning" class="t warn">{{ sec.tally.warning }} degraded</span>
          <span v-if="!sec.attention" class="t ok">all healthy</span>
        </span>
      </header>

      <template v-if="!collapsed.has(sec.key) || sec.hideHeader">
        <div v-if="layout === 'cards'" class="cards">
          <router-link v-for="s in sec.servers" :key="s.id" :to="`/servers/${s.id}`" class="cardlink">
            <article class="scard" :class="s.health">
              <header>
                <span class="dot" :class="s.health"></span>
                <span class="name" :title="`${s.name} · ${s.id}`">{{ s.name }}</span>
                <span v-if="s.health !== 'online'" class="state" :class="s.health">{{ s.health }}</span>
              </header>
              <div v-if="s.current" class="meters">
                <Meter compact label="CPU" :value="s.current.cpu" :warn="LIMITS.cpu[0]" :crit="LIMITS.cpu[1]" />
                <Meter compact label="RAM" :value="s.current.ram" :warn="LIMITS.ram[0]" :crit="LIMITS.ram[1]" />
                <Meter compact label="DISK" :value="s.current.disk" :warn="LIMITS.disk[0]" :crit="LIMITS.disk[1]" />
              </div>
              <div v-else class="nodata">
                {{ s.health === 'offline' ? `no samples · ${ago(s.last_seen)}` : 'waiting for first sample' }}
              </div>
            </article>
          </router-link>
        </div>

        <div v-else class="card rows-card">
          <table class="rows">
            <thead>
              <tr>
                <th>Server</th><th class="num">CPU</th><th class="num">RAM</th>
                <th class="num">Disk</th><th>Free</th><th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in sec.servers" :key="s.id" class="rowline" :class="s.health"
                  @click="$router.push(`/servers/${s.id}`)">
                <td class="who">
                  <span class="dot" :class="s.health"></span>
                  <router-link :to="`/servers/${s.id}`" @click.stop>{{ s.name }}</router-link>
                  <span v-if="s.health !== 'online'" class="state" :class="s.health">{{ s.health }}</span>
                </td>
                <td class="num" :class="level(s.current?.cpu, LIMITS.cpu)">{{ pct(s.current?.cpu) }}</td>
                <td class="num" :class="level(s.current?.ram, LIMITS.ram)">{{ pct(s.current?.ram) }}</td>
                <td class="num" :class="level(s.current?.disk, LIMITS.disk)">{{ pct(s.current?.disk) }}</td>
                <td class="muted num">{{ diskFree(s.current) || '—' }}</td>
                <td class="muted">{{ ago(s.last_seen) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

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
        <h2>Groups</h2>
        <table>
          <thead><tr><th>Group</th><th>Env</th><th class="num">Servers</th><th class="num">Critical</th></tr></thead>
          <tbody>
            <tr v-for="p in groups" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="muted">{{ p.environment }}</td>
              <td class="num">{{ p.server_count }}</td>
              <td class="num" :style="p.open_critical ? 'color: var(--critical); font-weight: 700' : ''">{{ p.open_critical }}</td>
            </tr>
            <tr v-if="!groups.length"><td colspan="4" class="empty">No groups yet — create one in Groups.</td></tr>
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
.search { min-width: 160px; }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); white-space: nowrap; }
.chk input { width: auto; }

/* Group sections */
.gsec { margin-bottom: 14px; }
.ghead {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 5px 2px 7px; border-bottom: 1px solid var(--grid); margin-bottom: 9px;
  user-select: none;
}
.ghead:hover .glabel { color: var(--accent); }
.caret { font-size: 10px; color: var(--muted); transition: transform 0.15s ease; display: inline-block; }
.caret.open { transform: rotate(90deg); }
.glabel { font-weight: 650; font-size: 13px; }
.genv { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.gcount {
  font-size: 11px; color: var(--ink-2); background: var(--grid);
  border-radius: 999px; padding: 1px 8px; font-variant-numeric: tabular-nums;
}
.tally { margin-left: auto; display: flex; gap: 10px; font-size: 11px; font-variant-numeric: tabular-nums; }
.tally .t.crit { color: var(--critical); font-weight: 650; }
.tally .t.off { color: var(--offline); }
.tally .t.warn { color: var(--warning); }
.tally .t.ok { color: var(--muted); }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(186px, 1fr)); gap: 9px; }
.cardlink { text-decoration: none; color: inherit; }
.cardlink:hover { text-decoration: none; }

.scard {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 11px 10px; height: 100%;
  border-left: 3px solid var(--good);
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.scard:hover { transform: translateY(-1px); box-shadow: 0 3px 12px rgba(0, 0, 0, 0.08); }
.scard.warning { border-left-color: var(--warning); }
.scard.critical { border-left-color: var(--critical); }
.scard.offline { border-left-color: var(--offline); }
.scard.offline .meters { opacity: 0.5; }

.scard header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--good); }
.dot.warning { background: var(--warning); }
.dot.critical { background: var(--critical); }
.dot.offline { background: var(--offline); }
.name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state {
  margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--muted); font-weight: 700; flex: none;
}
.state.critical { color: var(--critical); }
.state.warning { color: var(--warning); }

.meters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.nodata { color: var(--muted); font-size: 11px; padding: 7px 0 5px; }

.rows-card { padding-top: 6px; }
table.rows { font-variant-numeric: tabular-nums; }
table.rows th { font-size: 11px; }
.rowline { cursor: pointer; }
.rowline:hover { background: color-mix(in oklab, var(--accent) 6%, transparent); }
.rowline td { padding-top: 5px; padding-bottom: 5px; }
.rowline .who { display: flex; align-items: center; gap: 7px; }
.rowline .who .state { margin-left: 0; }
.rowline td.warn { color: var(--warning); font-weight: 600; }
.rowline td.crit { color: var(--critical); font-weight: 700; }
.rowline.offline td:not(.who) { opacity: 0.5; }

.grid.two { grid-template-columns: 1.3fr 1fr; align-items: start; margin-top: 4px; }
@media (max-width: 900px) { .grid.two { grid-template-columns: 1fr; } }
</style>
