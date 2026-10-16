<script setup>
import { ref, computed } from 'vue';
import { useAuth } from './stores/auth.js';
import { useRoute } from 'vue-router';
import { api } from './api.js';
const auth = useAuth();
const route = useRoute();
const pageTitle = computed(() => ({
  '/': 'Fleet overview', '/incidents': 'Incidents', '/rules': 'Alert rules',
  '/projects': 'Groups', '/chat': 'AI assistant', '/reports': 'Reports', '/settings': 'Settings',
})[route.path] || (route.path.startsWith('/servers/') ? 'Server details' : 'Workspace'));

// Every role can change its own password, so this lives in the sidebar rather
// than on Settings, which only admins can open.
const pwOpen = ref(false);
const pw = ref({ current: '', next: '', confirm: '' });
const pwError = ref('');
const pwDone = ref('');

function openPw() {
  pw.value = { current: '', next: '', confirm: '' };
  pwError.value = ''; pwDone.value = ''; pwOpen.value = true;
}

async function changePassword() {
  pwError.value = '';
  if (pw.value.next !== pw.value.confirm) { pwError.value = 'The two new passwords do not match'; return; }
  if (pw.value.next.length < 8) { pwError.value = 'New password must be at least 8 characters'; return; }
  try {
    const r = await api('/api/v1/auth/change-password', {
      method: 'POST',
      body: { current_password: pw.value.current, new_password: pw.value.next },
    });
    auth.setTokens(r);
    pwDone.value = 'Password changed. Any other device signed in as you has been signed out.';
    pw.value = { current: '', next: '', confirm: '' };
  } catch (e) { pwError.value = e.message; }
}
</script>

<template>
  <div v-if="route.path === '/login'"><router-view /></div>
  <div v-else class="layout">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">M</span><span class="brand-name">MONIT<span class="brand-accent">.OS</span></span></div>
      <div class="nav-caption">MONITORING</div>
      <nav class="nav-group">
        <router-link class="navlink" to="/"><span class="nav-icon">◈</span><span>Fleet overview</span><span class="nav-arrow">›</span></router-link>
        <router-link class="navlink" to="/incidents"><span class="nav-icon">◉</span><span>Incidents</span></router-link>
        <router-link class="navlink" to="/rules"><span class="nav-icon">⌁</span><span>Alert rules</span></router-link>
      </nav>
      <div class="nav-caption">MANAGE</div>
      <nav class="nav-group">
        <router-link class="navlink" to="/projects"><span class="nav-icon">▦</span><span>Groups</span></router-link>
        <router-link class="navlink" to="/reports"><span class="nav-icon">▤</span><span>Reports</span></router-link>
        <router-link class="navlink" to="/chat"><span class="nav-icon">✳</span><span>AI assistant</span><span class="ai-tag">AI</span></router-link>
        <router-link v-if="auth.isAdmin" class="navlink" to="/settings"><span class="nav-icon">⚙</span><span>Settings</span></router-link>
      </nav>
      <div class="sidebar-status"><span class="pulse-dot"></span><div><strong>System operational</strong><small>Data collection active</small></div></div>
      <div class="foot">
        <div class="user-avatar">{{ (auth.user?.email || 'U').slice(0, 1).toUpperCase() }}</div>
        <div class="user-info"><div class="user-email">{{ auth.user?.email }}</div><div class="muted">{{ auth.user?.role }}</div></div>
        <button class="icon-button" title="Change password" @click="openPw">···</button>
        <button class="sm signout" @click="auth.logout()">Sign out</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="crumb"><span>WORKSPACE</span><b>/</b>{{ pageTitle }}</div><div class="topbar-right"><span class="live-indicator"><i></i> Live monitoring</span><span class="topbar-divider"></span><span class="topbar-date">{{ new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }}</span></div></header>
      <div class="page-content"><router-view /></div>
    </main>

    <div v-if="pwOpen" class="modal-wrap" @click.self="pwOpen = false">
      <form class="card modal" @submit.prevent="changePassword">
        <h2>Change your password</h2>
        <div v-if="pwError" class="error-banner">{{ pwError }}</div>
        <div v-if="pwDone" class="done">{{ pwDone }}</div>
        <template v-if="!pwDone">
          <label class="f">Current password
            <input v-model="pw.current" type="password" autocomplete="current-password" required /></label>
          <label class="f">New password
            <input v-model="pw.next" type="password" minlength="8" autocomplete="new-password" required /></label>
          <label class="f">Confirm new password
            <input v-model="pw.confirm" type="password" minlength="8" autocomplete="new-password" required /></label>
          <p class="muted" style="font-size: 12px; margin: 0">
            At least 8 characters. Changing it signs out every other device.
          </p>
        </template>
        <div class="row" style="justify-content: flex-end">
          <button type="button" @click="pwOpen = false">{{ pwDone ? 'Close' : 'Cancel' }}</button>
          <button v-if="!pwDone" class="primary" type="submit">Change password</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: grid; place-items: center; z-index: 60; }
.modal { width: 380px; max-width: 94vw; display: flex; flex-direction: column; gap: 10px; }
.done {
  background: color-mix(in oklab, var(--good) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--good) 40%, var(--border));
  border-radius: 8px; padding: 9px 11px; font-size: 13px;
}
</style>
