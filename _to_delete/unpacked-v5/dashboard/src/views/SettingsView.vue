<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api.js';
import { fmtTime } from '../util.js';

const users = ref([]);
const channels = ref([]);
const log = ref([]);
const error = ref('');
const toast = ref('');
const newUser = ref({ email: '', name: '', password: '', role: 'viewer' });
const newChannel = ref({ name: '', type: 'telegram', bot_token: '', chat_id: '', webhook_url: '', url: '' });

async function load() {
  try {
    const [u, c, l] = await Promise.all([api('/api/v1/users'), api('/api/v1/channels'), api('/api/v1/notification-log')]);
    users.value = u.users; channels.value = c.channels; log.value = l.log;
    error.value = '';
  } catch (e) { error.value = e.message; }
}
onMounted(load);

function flash(m) { toast.value = m; setTimeout(() => (toast.value = ''), 2600); }

async function createUser() {
  try {
    await api('/api/v1/users', { method: 'POST', body: newUser.value });
    newUser.value = { email: '', name: '', password: '', role: 'viewer' };
    await load(); flash('User created');
  } catch (e) { error.value = e.message; }
}

async function setRole(u, role) {
  await api(`/api/v1/users/${u.id}`, { method: 'PATCH', body: { role } });
  await load();
}

async function toggleUser(u) {
  await api(`/api/v1/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } });
  await load();
}

const channelConfig = computed(() => {
  const c = newChannel.value;
  if (c.type === 'telegram') return { bot_token: c.bot_token, chat_id: c.chat_id };
  if (c.type === 'slack') return { webhook_url: c.webhook_url };
  return { url: c.url };
});

async function createChannel() {
  try {
    await api('/api/v1/channels', {
      method: 'POST',
      body: { name: newChannel.value.name, type: newChannel.value.type, config: channelConfig.value },
    });
    newChannel.value = { name: '', type: 'telegram', bot_token: '', chat_id: '', webhook_url: '', url: '' };
    await load(); flash('Channel created');
  } catch (e) { error.value = e.message; }
}

async function testChannel(c) {
  try {
    await api('/api/v1/webhooks/test', { method: 'POST', body: { channel: c.name } });
    flash(`Test sent to ${c.name}`);
    await load();
  } catch (e) { error.value = e.message; }
}

async function delChannel(c) {
  if (!confirm(`Delete channel "${c.name}"?`)) return;
  await api(`/api/v1/channels/${c.id}`, { method: 'DELETE' });
  await load();
}
</script>

<template>
  <h1>Settings</h1>
  <div v-if="error" class="error-banner">{{ error }}</div>

  <div class="grid" style="grid-template-columns: 1fr 1fr; align-items: start">
    <div class="card">
      <h2>Users</h2>
      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.email }}</td>
            <td class="muted">{{ u.name || '—' }}</td>
            <td>
              <select :value="u.role" @change="setRole(u, $event.target.value)" style="padding: 2px 6px; font-size: 12px">
                <option v-for="r in ['viewer', 'operator', 'admin']" :key="r" :value="r">{{ r }}</option>
              </select>
            </td>
            <td><span class="badge" :class="u.disabled ? 'offline' : 'online'">{{ u.disabled ? 'disabled' : 'active' }}</span></td>
            <td><button class="sm" @click="toggleUser(u)">{{ u.disabled ? 'Enable' : 'Disable' }}</button></td>
          </tr>
        </tbody>
      </table>
      <h2 style="margin-top: 14px">Add user</h2>
      <form class="row" @submit.prevent="createUser">
        <input v-model="newUser.email" type="email" placeholder="email" required style="flex: 1" />
        <input v-model="newUser.name" placeholder="name" style="width: 110px" />
        <input v-model="newUser.password" type="password" placeholder="password (8+)" minlength="8" required style="width: 140px" />
        <select v-model="newUser.role">
          <option v-for="r in ['viewer', 'operator', 'admin']" :key="r" :value="r">{{ r }}</option>
        </select>
        <button class="primary" type="submit">Add</button>
      </form>
    </div>

    <div class="card">
      <h2>Notification channels</h2>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          <tr v-for="c in channels" :key="c.id">
            <td><b>{{ c.name }}</b></td>
            <td class="muted">{{ c.type }}</td>
            <td><span class="badge" :class="c.enabled ? 'online' : 'offline'">{{ c.enabled ? 'on' : 'off' }}</span></td>
            <td>
              <button class="sm" @click="testChannel(c)">Test</button>
              <button class="sm danger" @click="delChannel(c)">Delete</button>
            </td>
          </tr>
          <tr v-if="!channels.length"><td colspan="4" class="empty">No channels — alerts will fire but not notify.</td></tr>
        </tbody>
      </table>

      <h2 style="margin-top: 14px">Add channel</h2>
      <form style="display: flex; flex-direction: column; gap: 8px" @submit.prevent="createChannel">
        <div class="row">
          <input v-model="newChannel.name" placeholder="channel name (e.g. oncall)" required style="flex: 1" />
          <select v-model="newChannel.type">
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
            <option value="webhook">Webhook</option>
          </select>
        </div>
        <template v-if="newChannel.type === 'telegram'">
          <input v-model="newChannel.bot_token" placeholder="bot token (from @BotFather)" required />
          <input v-model="newChannel.chat_id" placeholder="chat id (e.g. -1001234567890)" required />
        </template>
        <input v-if="newChannel.type === 'slack'" v-model="newChannel.webhook_url" placeholder="https://hooks.slack.com/services/..." required />
        <input v-if="newChannel.type === 'webhook'" v-model="newChannel.url" placeholder="https://your-endpoint/hook" required />
        <div class="row" style="justify-content: flex-end"><button class="primary" type="submit">Add channel</button></div>
      </form>
    </div>
  </div>

  <div class="card" style="margin-top: 12px">
    <h2>Notification log</h2>
    <table>
      <thead><tr><th>Time</th><th>Channel</th><th>Event</th><th>Incident</th><th>Result</th></tr></thead>
      <tbody>
        <tr v-for="l in log" :key="l.id">
          <td class="muted">{{ fmtTime(l.created_at) }}</td>
          <td>{{ l.channel }}</td>
          <td class="mono">{{ l.event }}</td>
          <td class="mono muted">{{ l.incident_id || '—' }}</td>
          <td><span class="badge" :class="l.success ? 'online' : 'critical'">{{ l.success ? 'sent' : (l.response?.error || 'failed') }}</span></td>
        </tr>
        <tr v-if="!log.length"><td colspan="5" class="empty">No deliveries yet.</td></tr>
      </tbody>
    </table>
  </div>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
