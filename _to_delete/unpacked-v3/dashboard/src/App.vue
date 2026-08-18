<script setup>
import { useAuth } from './stores/auth.js';
import { useRoute } from 'vue-router';
const auth = useAuth();
const route = useRoute();
</script>

<template>
  <div v-if="route.path === '/login'"><router-view /></div>
  <div v-else class="layout">
    <nav class="sidebar">
      <div class="brand">mon<span>it</span></div>
      <router-link class="navlink" to="/">Fleet</router-link>
      <router-link class="navlink" to="/incidents">Incidents</router-link>
      <router-link class="navlink" to="/rules">Alert rules</router-link>
      <router-link class="navlink" to="/projects">Projects</router-link>
      <router-link v-if="auth.isAdmin" class="navlink" to="/settings">Settings</router-link>
      <div class="foot">
        <div>{{ auth.user?.email }}</div>
        <div class="muted">{{ auth.user?.role }}</div>
        <button class="sm" style="margin-top: 8px" @click="auth.logout()">Sign out</button>
      </div>
    </nav>
    <main class="main"><router-view /></main>
  </div>
</template>
