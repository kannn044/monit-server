// Small fetch wrapper with JWT + automatic refresh.
import { useAuth } from './stores/auth.js';
import { API_BASE } from './base.js';

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const auth = useAuth();
  // Only declare a JSON body when there is one. Announcing application/json on
  // a bodyless POST (key rotate, restore, ack…) makes Fastify's parser reject
  // the request with 400 "Body cannot be empty" before the route ever runs.
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
