import { defineStore } from 'pinia';
import { API_BASE } from '../base.js';

export const useAuth = defineStore('auth', {
  state: () => ({
    accessToken: sessionStorage.getItem('mon_at') || '',
    refreshToken: sessionStorage.getItem('mon_rt') || '',
    user: JSON.parse(sessionStorage.getItem('mon_user') || 'null'),
  }),
  getters: {
    loggedIn: (s) => !!s.accessToken,
    isOperator: (s) => ['operator', 'admin'].includes(s.user?.role),
    isAdmin: (s) => s.user?.role === 'admin',
  },
  actions: {
    async login(email, password) {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).title || 'Login failed');
      const j = await res.json();
      this.accessToken = j.access_token; this.refreshToken = j.refresh_token; this.user = j.user;
      sessionStorage.setItem('mon_at', j.access_token);
      sessionStorage.setItem('mon_rt', j.refresh_token);
      sessionStorage.setItem('mon_user', JSON.stringify(j.user));
    },
    async refresh() {
      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: this.refreshToken }),
        });
        if (!res.ok) return false;
        const j = await res.json();
        this.accessToken = j.access_token; this.user = j.user;
        sessionStorage.setItem('mon_at', j.access_token);
        sessionStorage.setItem('mon_user', JSON.stringify(j.user));
        return true;
      } catch { return false; }
    },
    logout() {
      this.accessToken = ''; this.refreshToken = ''; this.user = null;
      sessionStorage.clear();
      location.href = import.meta.env.BASE_URL;
    },
  },
});
