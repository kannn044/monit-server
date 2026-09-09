<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { useAuth } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();
const auth = useAuth();

const kinds = ref({});
const reports = ref([]);
const current = ref(null);
const loading = ref(false);
const busy = ref('');
const error = ref('');
const lang = ref('th');
const now = ref(Date.now());

let poll = null;
let tick = null;

/**
 * Elapsed and remaining come from the report's own created_at, not from when
 * this component happened to mount.
 *
 * Counting from mount looked right until you switched tabs and came back, at
 * which point a report two minutes in claimed to have just started. The server
 * knows when it began and roughly how long this kind takes on this hardware,
 * so the page derives both from that — a reload, another tab or another
 * machine all show the same clock.
 */
const startedAt = computed(() => (current.value?.created_at ? new Date(current.value.created_at).getTime() : null));
const elapsed = computed(() => (startedAt.value ? Math.max(0, Math.round((now.value - startedAt.value) / 1000)) : 0));
const eta = computed(() => Number(current.value?.eta_seconds) || 90);
const remaining = computed(() => eta.value - elapsed.value);
const overrun = computed(() => remaining.value < 0);
const pctDone = computed(() => Math.min(100, Math.round((elapsed.value / Math.max(eta.value, 1)) * 100)));

const openId = computed(() => route.params.id || null);
const pending = computed(() => current.value?.status === 'pending');
const failed = computed(() => current.value?.status === 'failed');

async function loadList() {
  try {
    const r = await api('/api/v1/reports');
    kinds.value = r.kinds;
    reports.value = r.reports;
  } catch (e) { error.value = e.message; }
}

async function loadOne(id, quiet = false) {
  if (!id) { current.value = null; stopPolling(); return; }
  if (!quiet) loading.value = true;
  try {
    current.value = await api(`/api/v1/reports/${id}`);
    if (current.value.status === 'pending') startPolling(id);
    else stopPolling();
  } catch (e) { error.value = e.message; stopPolling(); }
  finally { loading.value = false; }
}

/**
 * Poll while a report is being written.
 *
 * Generation is a model call that runs for a minute or more on a local GPU, so
 * the server hands back a row immediately and fills it in afterwards. Polling
 * is what turns that into something the page can show: a live elapsed count
 * instead of a disabled button and no explanation.
 */
function startPolling(id) {
  if (poll) clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const r = await api(`/api/v1/reports/${id}`);
      current.value = r;
      if (r.status !== 'pending') { stopPolling(); await loadList(); }
    } catch { /* a dropped poll is not worth an error banner; the next one retries */ }
  }, 2500);
}

function stopPolling() {
  if (poll) { clearInterval(poll); poll = null; }
}

async function generate(kind) {
  error.value = '';
  busy.value = kind;
  try {
    // 202 with a pending row — the work carries on server-side.
    const row = await api('/api/v1/reports', { method: 'POST', body: { kind, lang: lang.value } });
    await loadList();
    router.push(`/reports/${row.id}`);
    current.value = row;
    startPolling(row.id);
  } catch (e) {
    error.value = e.message;
  } finally { busy.value = ''; }
}

async function retry() {
  if (current.value) await generate(current.value.kind);
}

async function remove(id) {
  try {
    await api(`/api/v1/reports/${id}`, { method: 'DELETE' });
    if (openId.value === id) router.push('/reports');
    await loadList();
  } catch (e) { error.value = e.message; }
}

/**
 * Download builds a blob rather than linking to an endpoint: the HTML lives
 * inside an authenticated JSON response, so there is no URL a browser could
 * fetch on its own without inventing a second auth mechanism for it.
 */
function download() {
  if (!current.value?.html) return;
  const blob = new Blob([current.value.html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.value.kind}-${new Date(current.value.created_at).toISOString().slice(0, 16).replace(/[:T]/g, '')}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const when = (t) => new Date(t).toLocaleString('sv-SE').slice(0, 16);
const mmss = (s) => {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

onMounted(async () => {
  // The clock ticks for the whole page, not just for the open report: a pending
  // row in the list shows its own running time, and that has to keep moving
  // whether or not the report is the one on screen.
  tick = setInterval(() => { now.value = Date.now(); }, 1000);
  await loadList();
  await loadOne(openId.value);
});
onUnmounted(() => { stopPolling(); if (tick) { clearInterval(tick); tick = null; } });
watch(openId, (id) => loadOne(id));
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; align-items: flex-start">
      <div>
        <h1 style="margin-bottom: 4px">Reports</h1>
        <p class="muted" style="margin: 0 0 14px; font-size: 13px; max-width: 62ch">
          ตัวเลขทุกตัวคำนวณจากฐานข้อมูลโดยตรง ส่วนคำอธิบายเขียนโดยโมเดล — กราฟกับตารางจึงไม่มีทางขัดกับข้อมูลจริง
        </p>
      </div>
      <div class="row" style="gap: 6px">
        <select v-model="lang" class="sel"><option value="th">ไทย</option><option value="en">English</option></select>
        <router-link class="sm-link" to="/chat">AI Chat</router-link>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="gen">
      <button v-for="(label, kind) in kinds" :key="kind" class="genbtn"
              :class="{ working: busy === kind }" :disabled="!!busy" @click="generate(kind)">
        <span class="gl">{{ label }}</span>
        <span class="gs">
          <span v-if="busy === kind" class="spin"></span>
          {{ busy === kind ? 'กำลังเริ่ม…' : 'สร้างรายงาน' }}
        </span>
      </button>
    </div>

    <div class="split">
      <aside class="list card">
        <h2>รายงานที่มี</h2>
        <p v-if="!reports.length" class="muted" style="font-size: 13px">ยังไม่มีรายงาน — กดปุ่มด้านบนเพื่อสร้าง</p>
        <router-link v-for="r in reports" :key="r.id" class="item" :class="{ on: r.id === openId }"
                     :to="`/reports/${r.id}`">
          <div class="it">
            {{ r.title }}
            <span v-if="r.status === 'pending'" class="pill wait">กำลังสร้าง {{ mmss((now - new Date(r.created_at).getTime()) / 1000) }}</span>
            <span v-else-if="r.status === 'failed'" class="pill bad">ล้มเหลว</span>
          </div>
          <div class="is">{{ when(r.created_at) }} · {{ r.findings }} findings</div>
          <button v-if="auth.isAdmin" class="del" title="ลบ" @click.prevent.stop="remove(r.id)">×</button>
        </router-link>
      </aside>

      <section class="viewer">
        <div v-if="!openId" class="card empty">
          เลือกรายงานจากรายการ หรือสร้างใหม่จากปุ่มด้านบน
        </div>
        <div v-else-if="loading" class="card empty">กำลังโหลด…</div>

        <!-- being written: this is the state the page used to have no words for -->
        <div v-else-if="pending" class="card progress">
          <div class="spin big"></div>
          <div class="pt">{{ current.title }}</div>
          <div class="pm">กำลังให้โมเดลเขียนบทวิเคราะห์</div>

          <div v-if="!overrun" class="pe">เหลืออีกประมาณ {{ mmss(remaining) }}</div>
          <div v-else class="pe over">เกินเวลาที่ประมาณไว้ {{ mmss(-remaining) }}</div>

          <div class="bar"><div class="fill" :class="{ indet: overrun }"
               :style="overrun ? null : { width: pctDone + '%' }"></div></div>

          <div class="psub">
            ผ่านไปแล้ว {{ mmss(elapsed) }} · ปกติรายงานแบบนี้ใช้เวลาราว {{ mmss(eta) }}
            <span class="muted">(วัดจากรายงานก่อนหน้าบนเครื่องนี้)</span>
          </div>

          <div class="pn">
            ตัวเลขและกราฟคำนวณเสร็จแล้ว ที่รออยู่คือคำอธิบาย ·
            <strong>ปิดหน้านี้ไปทำอย่างอื่นได้เลย</strong> — รายงานจะถูกบันทึกไว้ และเวลาที่นับจะยังตรงเมื่อกลับมาดู
          </div>
        </div>

        <div v-else-if="failed" class="card progress fail">
          <div class="pt">สร้างรายงานไม่สำเร็จ</div>
          <div class="pm">{{ current.error || 'ไม่ทราบสาเหตุ' }}</div>
          <button class="primary" style="margin-top: 12px" @click="retry">ลองใหม่</button>
        </div>

        <div v-else-if="current" class="card frame-card">
          <div class="row" style="justify-content: space-between; margin-bottom: 10px">
            <div>
              <div style="font-weight: 600">{{ current.title }}</div>
              <div class="muted" style="font-size: 12px">
                {{ when(current.created_at) }} · {{ current.created_by || 'system' }}
              </div>
            </div>
            <button class="sm" @click="download">Download HTML</button>
          </div>
          <!-- sandboxed: the report is generated markup, so it is rendered with
               no script execution and no access back into the dashboard -->
          <iframe class="frame" :srcdoc="current.html" sandbox="allow-same-origin" title="report"></iframe>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sel { background: var(--surface); border: 1px solid var(--border); color: var(--ink); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 13px; }
.sm-link { font-size: 12px; color: var(--ink-2); border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; }
.sm-link:hover { text-decoration: none; border-color: var(--accent); color: var(--ink); }

.gen { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 18px; }
.genbtn { text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; color: var(--ink); }
.genbtn:hover:not(:disabled) { border-color: var(--accent); }
.genbtn:disabled { opacity: 0.5; cursor: default; }
.genbtn.working { opacity: 1; border-color: var(--accent); }
.gl { font-weight: 600; font-size: 13.5px; }
.gs { font-size: 12px; color: var(--accent); display: flex; align-items: center; gap: 6px; }

.spin { width: 11px; height: 11px; border: 2px solid color-mix(in oklab, var(--accent) 30%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: sp 0.7s linear infinite; flex: none; }
.spin.big { width: 26px; height: 26px; border-width: 3px; margin-bottom: 14px; }
@keyframes sp { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }

.split { display: grid; grid-template-columns: 280px 1fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }

.list h2 { margin-bottom: 8px; }
.item { display: block; position: relative; padding: 8px 26px 8px 10px; border-radius: 8px; color: var(--ink); }
.item:hover { background: color-mix(in oklab, var(--accent) 8%, transparent); text-decoration: none; }
.item.on { background: color-mix(in oklab, var(--accent) 14%, transparent); }
.it { font-size: 13px; font-weight: 500; }
.is { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 999px; margin-left: 6px; font-weight: 600; vertical-align: 1px; }
.pill.wait { color: var(--warning); background: color-mix(in oklab, var(--warning) 16%, transparent); }
.pill.bad { color: var(--critical); background: color-mix(in oklab, var(--critical) 14%, transparent); }
.del { position: absolute; right: 6px; top: 8px; background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; }
.del:hover { color: var(--critical); }

.empty { color: var(--muted); text-align: center; padding: 48px 20px; }
.progress { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 52px 24px; }
.progress.fail { border-left: 3px solid var(--critical); }
.pt { font-weight: 600; font-size: 15px; }
.pm { color: var(--ink-2); font-size: 13px; margin-top: 6px; max-width: 46ch; }
.pe { font-size: 27px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 16px 0 10px; color: var(--accent); }
.pe.over { color: var(--warning); font-size: 20px; }
.bar { width: min(340px, 80%); height: 6px; border-radius: 3px; background: var(--grid); overflow: hidden; }
.fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.9s linear; }
/* Past the estimate the bar stops claiming to know how far along it is. */
.fill.indet { width: 34%; background: var(--warning); animation: slide 1.6s ease-in-out infinite alternate; }
@keyframes slide { from { transform: translateX(-60%); } to { transform: translateX(220%); } }
.psub { margin-top: 12px; font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.psub .muted { color: var(--muted); }
.pn { color: var(--muted); font-size: 12px; max-width: 52ch; line-height: 1.6; margin-top: 10px; }
@media (prefers-reduced-motion: reduce) { .fill.indet { animation: none; width: 100%; opacity: 0.45; } }

.frame-card { padding: 12px; }
.frame { width: 100%; height: calc(100vh - 260px); min-height: 460px; border: 1px solid var(--border); border-radius: 8px; background: var(--page); }
</style>
