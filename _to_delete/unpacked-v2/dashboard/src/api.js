// Small fetch wrapper with JWT + automatic refresh.
import { useAuth } from './stores/auth.js';

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const auth = useAuth();
  const headers = { 'Content-Type': 'application/json' };
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && retry && auth.refreshToken) {
    const ok = await auth.refresh();
    if (ok) return api(path, { method, body, retry: false });
    auth.logout();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.title || j.detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}
