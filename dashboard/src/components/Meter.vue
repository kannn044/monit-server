<script setup>
// A utilization bar. The percentage is always written out, so the colour is a
// second signal rather than the only one — required for the status hues, which
// never carry meaning alone.
import { computed } from 'vue';

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number, default: null },   // 0–100, null = no data
  warn: { type: Number, default: 75 },
  crit: { type: Number, default: 90 },
  sub: { type: String, default: '' },       // e.g. "31 GB free"
});

const level = computed(() => {
  if (props.value === null || props.value === undefined) return 'none';
  if (props.value >= props.crit) return 'crit';
  if (props.value >= props.warn) return 'warn';
  return 'ok';
});
const width = computed(() => Math.max(0, Math.min(100, props.value ?? 0)));
</script>

<template>
  <div class="meter" :class="level">
    <div class="head">
      <span class="lab">{{ label }}</span>
      <span class="val">{{ value === null ? '—' : value.toFixed(0) + '%' }}</span>
    </div>
    <div class="track" role="img" :aria-label="`${label} ${value === null ? 'no data' : value.toFixed(0) + '%'}`">
      <div class="fill" :style="{ width: width + '%' }"></div>
    </div>
    <div v-if="sub" class="sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.meter { min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; margin-bottom: 3px; }
.lab { font-size: 11px; color: var(--muted); letter-spacing: 0.02em; }
.val { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink); }
.track { height: 6px; border-radius: 999px; background: var(--grid); overflow: hidden; }
.fill { height: 100%; border-radius: 999px; background: var(--series-1); transition: width 0.4s ease; }
.warn .fill { background: var(--warning); }
.crit .fill { background: var(--critical); }
.crit .val { color: var(--critical); }
.none .fill { background: var(--muted); opacity: 0.35; }
.sub { font-size: 10px; color: var(--muted); margin-top: 3px; font-variant-numeric: tabular-nums; }
</style>
