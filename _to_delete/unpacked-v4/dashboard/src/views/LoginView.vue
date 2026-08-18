<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../stores/auth.js';

const auth = useAuth();
const router = useRouter();
const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true; error.value = '';
  try {
    await auth.login(email.value, password.value);
    router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <form class="card box" @submit.prevent="submit">
      <div class="brand">mon<span>it</span></div>
      <p class="muted" style="margin-top: 0">Server monitoring dashboard</p>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <label class="f">Email
        <input v-model="email" type="email" required autocomplete="username" />
      </label>
      <label class="f">Password
        <input v-model="password" type="password" required autocomplete="current-password" />
      </label>
      <button class="primary" :disabled="busy" type="submit">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
    </form>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: grid; place-items: center; background: var(--page); }
.box { width: 340px; display: flex; flex-direction: column; gap: 12px; padding: 26px 28px; }
.brand { font-weight: 700; font-size: 22px; }
.brand span { color: var(--accent); }
</style>
