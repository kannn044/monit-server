import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

import LoginView from './views/LoginView.vue';
import FleetView from './views/FleetView.vue';
import ServerDetail from './views/ServerDetail.vue';
import IncidentsView from './views/IncidentsView.vue';
import RulesView from './views/RulesView.vue';
import ProjectsView from './views/ProjectsView.vue';
import SettingsView from './views/SettingsView.vue';
import ChatView from './views/ChatView.vue';
import ReportsView from './views/ReportsView.vue';
import { useAuth } from './stores/auth.js';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/', component: FleetView },
    { path: '/servers/:id', component: ServerDetail },
    { path: '/incidents', component: IncidentsView },
    { path: '/rules', component: RulesView },
    { path: '/projects', component: ProjectsView },
    { path: '/settings', component: SettingsView },
    { path: '/chat', component: ChatView },
    { path: '/reports', component: ReportsView },
    { path: '/reports/:id', component: ReportsView },
  ],
});

const app = createApp(App);
app.use(createPinia());

router.beforeEach((to) => {
  const auth = useAuth();
  if (!to.meta.public && !auth.loggedIn) return '/login';
  if (to.path === '/login' && auth.loggedIn) return '/';
});

app.use(router);
app.mount('#app');
