<script setup>
// Multi-series SVG time chart: 2px lines, recessive grid, crosshair + tooltip,
// legend (always shown for ≥2 series), fixed categorical color order.
import { computed, ref } from 'vue';
import { SERIES_COLORS, fmt, fmtTime } from '../util.js';

const props = defineProps({
  series: { type: Object, default: () => ({}) },   // { name: [{t, v}] }
  unit: { type: String, default: '' },
  height: { type: Number, default: 180 },
  yMax: { type: Number, default: null },            // e.g. 100 for percents
  loading: { type: Boolean, default: false },
  // Series whose name starts with this prefix are drawn as one de-emphasized
  // ensemble (single muted color, one legend entry) instead of consuming
  // categorical slots. Keeps a 32-core CPU chart inside the 8-slot palette.
  ensemblePrefix: { type: String, default: '' },
});

const W = 800;
const PAD = { l: 46, r: 12, t: 10, b: 22 };
const hover = ref(null); // { x, t, values: [{name,color,v}] }

const names = computed(() => Object.keys(props.series).filter((n) => props.series[n]?.length));
const isEnsemble = (n) => !!props.ensemblePrefix && n.startsWith(props.ensemblePrefix);
const namedNames = computed(() => names.value.filter((n) => !isEnsemble(n)));
const ensembleNames = computed(() => names.value.filter(isEnsemble));

const extent = computed(() => {
  let t0 = Infinity, t1 = -Infinity, vMax = -Infinity;
  for (const n of names.value) {
    for (const p of props.series[n]) {
      const t = new Date(p.t).getTime();
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
      if (p.v !== null && p.v > vMax) vMax = p.v;
    }
  }
  if (!isFinite(t0)) return null;
  let max = props.yMax ?? (vMax <= 0 ? 1 : vMax * 1.1);
  if (props.yMax === null && vMax > 0) max = niceMax(vMax);
  return { t0, t1: t1 === t0 ? t0 + 1 : t1, max };
});

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

const x = (t) => PAD.l + ((t - extent.value.t0) / (extent.value.t1 - extent.value.t0)) * (W - PAD.l - PAD.r);
const y = (v) => PAD.t + (1 - v / extent.value.max) * (props.height - PAD.t - PAD.b);

function pathFor(name) {
  let d = ''; let pen = false;
  for (const p of props.series[name]) {
    if (p.v === null || p.v === undefined) { pen = false; continue; }
    const px = x(new Date(p.t).getTime()), py = y(Math.min(p.v, extent.value.max));
    d += (pen ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    pen = true;
  }
  return d;
}

// Named series take categorical slots 1..8 in fixed order (never cycled — we
// cap at 8 and fold the rest into the ensemble/overflow).
const paths = computed(() => {
  if (!extent.value) return [];
  return namedNames.value.slice(0, 8).map((name, i) => ({
    name, d: pathFor(name), color: SERIES_COLORS[i],
  }));
});

const ensemblePaths = computed(() => {
  if (!extent.value) return [];
  return ensembleNames.value.map((name) => ({ name, d: pathFor(name) }));
});

const overflow = computed(() => Math.max(0, namedNames.value.length - 8));

const yTicks = computed(() => {
  if (!extent.value) return [];
  return [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: extent.value.max * f, py: y(extent.value.max * f) }));
});

function onMove(ev) {
  if (!extent.value) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * W;
  const t = extent.value.t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (extent.value.t1 - extent.value.t0);
  const nearest = (name) => {
    let best = null, bd = Infinity;
    for (const p of props.series[name]) {
      const d = Math.abs(new Date(p.t).getTime() - t);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const values = namedNames.value.slice(0, 8).map((name, i) => {
    const best = nearest(name);
    return { name, color: SERIES_COLORS[i], v: best?.v ?? null, t: best?.t };
  });
  // ensemble collapses to a min–max range row rather than N tooltip lines
  if (ensembleNames.value.length) {
    const vals = ensembleNames.value.map((n) => nearest(n)?.v).filter((v) => v !== null && v !== undefined);
    if (vals.length) {
      values.push({
        name: `${ensembleNames.value.length} × ${props.ensemblePrefix.trim()}`,
        color: 'var(--muted)', ensemble: true,
        v: Math.min(...vals), vMax: Math.max(...vals),
        t: nearest(ensembleNames.value[0])?.t,
      });
    }
  }
  const snapT = values[0]?.t ? new Date(values[0].t).getTime() : t;
  hover.value = { x: Math.max(PAD.l, Math.min(W - PAD.r, x(snapT))), t: snapT, values };
}
</script>

<template>
  <div class="tc">
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="plot"
         @mousemove="onMove" @mouseleave="hover = null" role="img">
      <template v-if="extent">
        <line v-for="tk in yTicks" :key="tk.v" :x1="PAD.l" :x2="W - PAD.r" :y1="tk.py" :y2="tk.py"
              stroke="var(--grid)" stroke-width="1" />
        <text v-for="tk in yTicks" :key="'l' + tk.v" :x="PAD.l - 6" :y="tk.py + 4"
              text-anchor="end" class="tick">{{ fmt(tk.v, unit) }}</text>
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="y(0)" :y2="y(0)" stroke="var(--baseline)" stroke-width="1" />
        <!-- de-emphasized ensemble drawn first, under the named series -->
        <path v-for="p in ensemblePaths" :key="'e' + p.name" :d="p.d" fill="none" stroke="var(--muted)"
              stroke-width="1" stroke-opacity="0.45" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        <path v-for="p in paths" :key="p.name" :d="p.d" fill="none" :stroke="p.color"
              stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        <g v-if="hover">
          <line :x1="hover.x" :x2="hover.x" :y1="PAD.t" :y2="height - PAD.b"
                stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" />
        </g>
      </template>
      <text v-else :x="W / 2" :y="height / 2" text-anchor="middle" class="tick">
        {{ loading ? 'loading…' : 'no data' }}
      </text>
    </svg>
    <div v-if="hover" class="tip" :style="{ left: (hover.x / W * 100) + '%' }">
      <div class="t">{{ fmtTime(hover.t) }}</div>
      <div v-for="v in hover.values" :key="v.name" class="r">
        <span class="chip" :style="{ background: v.color }"></span>
        <span class="n">{{ v.name }}</span>
        <span class="v">{{ v.ensemble ? `${fmt(v.v, unit)}–${fmt(v.vMax, unit)}` : fmt(v.v, unit) }}</span>
      </div>
    </div>
    <div v-if="names.length >= 2" class="legend">
      <span v-for="p in paths" :key="p.name" class="li">
        <span class="chip" :style="{ background: p.color }"></span>{{ p.name }}
      </span>
      <span v-if="ensemblePaths.length" class="li">
        <span class="chip ens"></span>{{ ensemblePaths.length }} × {{ ensemblePrefix.trim() }}
      </span>
      <span v-if="overflow" class="muted">+{{ overflow }} more not shown</span>
    </div>
  </div>
</template>

<style scoped>
.tc { position: relative; }
.plot { width: 100%; display: block; }
.tick { font-size: 10px; fill: var(--muted); }
.tip {
  position: absolute; top: 6px; transform: translateX(8px);
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 6px 10px; pointer-events: none; z-index: 5; min-width: 130px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12); font-size: 12px;
}
.tip .t { color: var(--muted); margin-bottom: 3px; }
.tip .r { display: flex; align-items: center; gap: 6px; }
.tip .n { color: var(--ink-2); flex: 1; }
.tip .v { font-variant-numeric: tabular-nums; font-weight: 600; }
.chip { width: 9px; height: 9px; border-radius: 3px; display: inline-block; flex: none; }
.chip.ens { background: var(--muted); opacity: 0.5; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 12px; color: var(--ink-2); }
.li { display: inline-flex; align-items: center; gap: 6px; }
</style>
