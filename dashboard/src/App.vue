<script setup>
import { ref } from 'vue';
import { useAuth } from './stores/auth.js';
import { useRoute } from 'vue-router';
import { api } from './api.js';
const auth = useAuth();
const route = useRoute();

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
    <nav class="sidebar">
      <div class="brand">mon<span>it</span></div>
      <router-link class="navlink" to="/">Fleet</router-link>
      <router-link class="navlink" to="/incidents">Incidents</router-link>
      <router-link class="navlink" to="/rules">Alert rules</router-link>
      <router-link class="navlink" to="/projects">Groups</router-link>
      <router-link class="navlink" to="/chat">AI Chat</router-link>
      <router-link v-if="auth.isAdmin" class="navlink" to="/settings">Settings</router-link>
      <div class="foot">
        <div>{{ auth.user?.email }}</div>
        <div class="muted">{{ auth.user?.role }}</div>
        <div class="row" style="margin-top: 8px; gap: 6px">
          <button class="sm" @click="openPw">Password</button>
          <button class="sm" @click="auth.logout()">Sign out</button>
        </div>
      </div>
    </nav>
    <main class="main"><router-view /></main>

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
