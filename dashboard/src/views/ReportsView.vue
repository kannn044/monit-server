<script setup>
import { ref, onMounted, watch, computed } from 'vue';
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

const openId = computed(() => route.params.id || null);

async function loadList() {
  loading.value = true;
  try {
    const r = await api('/api/v1/reports');
    kinds.value = r.kinds;
    reports.value = r.reports;
  } catch (e) { error.value = e.message; } finally { loading.value = false; }
}

async function loadOne(id) {
  if (!id) { current.value = null; return; }
  loading.value = true;
  try { current.value = await api(`/api/v1/reports/${id}`); }
  catch (e) { error.value = e.message; } finally { loading.value = false; }
}

async function generate(kind) {
  error.value = '';
  busy.value = kind;
  try {
    const row = await api('/api/v1/reports', { method: 'POST', body: { kind, lang: lang.value } });
    await loadList();
    router.push(`/reports/${row.id}`);
  } catch (e) {
    error.value = e.message;
  } finally { busy.value = ''; }
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
  if (!current.value) return;
  const blob = new Blob([current.value.html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.value.kind}-${new Date(current.value.created_at).toISOString().slice(0, 16).replace(/[:T]/g, '')}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const when = (t) => new Date(t).toLocaleString('sv-SE').slice(0, 16);

onMounted(async () => { await loadList(); await loadOne(openId.value); });
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
              :disabled="!!busy" @click="generate(kind)">
        <span class="gl">{{ label }}</span>
        <span class="gs">{{ busy === kind ? 'กำลังสร้าง…' : 'สร้างรายงาน' }}</span>
      </button>
    </div>

    <div class="split">
      <aside class="list card">
        <h2>รายงานที่มี</h2>
        <p v-if="!reports.length && !loading" class="muted" style="font-size: 13px">ยังไม่มีรายงาน — กดปุ่มด้านบนเพื่อสร้าง</p>
        <router-link v-for="r in reports" :key="r.id" class="item" :class="{ on: r.id === openId }"
                     :to="`/reports/${r.id}`">
          <div class="it">{{ r.title }}</div>
          <div class="is">{{ when(r.created_at) }} · {{ r.findings }} findings</div>
          <button v-if="auth.isAdmin" class="del" title="ลบ" @click.prevent.stop="remove(r.id)">×</button>
        </router-link>
      </aside>

      <section class="viewer">
        <div v-if="!openId" class="card empty">
          เลือกรายงานจากรายการ หรือสร้างใหม่จากปุ่มด้านบน
        </div>
        <div v-else-if="loading" class="card empty">กำลังโหลด…</div>
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
.genbtn:disabled { opacity: 0.55; cursor: default; }
.gl { font-weight: 600; font-size: 13.5px; }
.gs { font-size: 12px; color: var(--accent); }

.split { display: grid; grid-template-columns: 280px 1fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }

.list h2 { margin-bottom: 8px; }
.item { display: block; position: relative; padding: 8px 26px 8px 10px; border-radius: 8px; color: var(--ink); }
.item:hover { background: color-mix(in oklab, var(--accent) 8%, transparent); text-decoration: none; }
.item.on { background: color-mix(in oklab, var(--accent) 14%, transparent); }
.it { font-size: 13px; font-weight: 500; }
.is { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.del { position: absolute; right: 6px; top: 8px; background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; }
.del:hover { color: var(--critical); }

.empty { color: var(--muted); text-align: center; padding: 48px 20px; }
.frame-card { padding: 12px; }
.frame { width: 100%; height: calc(100vh - 260px); min-height: 460px; border: 1px solid var(--border); border-radius: 8px; background: var(--page); }
</style>
