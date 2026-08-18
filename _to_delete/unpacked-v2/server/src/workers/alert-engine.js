// Alert Engine — evaluates rules against fresh data on a fixed tick.
// State machine per (rule, server):  OK → (condition true ≥ duration) → FIRING → resolved.
// Includes: duration debounce, optional hysteresis (recover_threshold),
// flapping guard, silenced/acknowledged handling, periodic "still firing" reminders.
import crypto from 'node:crypto';
import { q } from '../db/pool.js';
import { config } from '../config.js';
import { extractMetric, compare } from '../lib/metrics.js';
import { enqueueNotifications } from './notifier.js';

const REMINDER_MIN = 60; // "still firing" reminder cadence

const newIncidentId = () => {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `inc_${ymd}_${crypto.randomBytes(3).toString('hex')}`;
};

async function buildNotifyPayload(rule, server, incident, event) {
  const { rows: proj } = await q(
    `SELECT p.name, p.environment FROM server_projects sp JOIN projects p ON p.id = sp.project_id
     WHERE sp.server_id = $1 LIMIT 1`, [server.id]);
  return {
    event,
    incident_id: incident.id,
    rule_id: rule.id,
    rule_name: rule.name,
    severity: rule.severity,
    server_id: server.id,
    server_name: server.name,
    project: proj[0]?.name || null,
    environment: proj[0]?.environment || null,
    metric: rule.metric,
    comparator: rule.comparator,
    value: incident.value,
    threshold: rule.threshold,
    duration_min: Number(rule.duration_min),
    started_at: incident.started_at,
    message: incident.message,
  };
}

function scopeServers(rule, servers, projectsByServer) {
  if (rule.scope_type === 'all') return servers;
  if (rule.scope_type === 'servers') return servers.filter((s) => rule.scope_ids.includes(s.id));
  // project scope
  return servers.filter((s) => (projectsByServer.get(s.id) || []).some((pid) => rule.scope_ids.includes(pid)));
}

export async function tick(boss, log = console) {
  const [{ rows: rules }, { rows: servers }, { rows: sp }, { rows: expected }] = await Promise.all([
    q('SELECT * FROM alert_rules WHERE enabled'),
    q('SELECT id, name, last_seen FROM servers WHERE archived_at IS NULL'),
    q('SELECT server_id, project_id FROM server_projects'),
    q('SELECT server_id, kind, name FROM expected_services WHERE enabled'),
  ]);
  if (!rules.length || !servers.length) return;

  const projectsByServer = new Map();
  for (const r of sp) (projectsByServer.get(r.server_id) || projectsByServer.set(r.server_id, []).get(r.server_id)).push(r.project_id);
  const expectedByServer = new Map();
  for (const e of expected) (expectedByServer.get(e.server_id) || expectedByServer.set(e.server_id, []).get(e.server_id)).push(e);

  // Latest sample per server (within the last 5 minutes)
  const { rows: latest } = await q(
    `SELECT DISTINCT ON (server_id) * FROM system_metrics
     WHERE time > now() - INTERVAL '5 minutes' ORDER BY server_id, time DESC`);
  const sampleByServer = new Map(latest.map((r) => [r.server_id, r]));

  const { rows: states } = await q('SELECT * FROM rule_state');
  const stateKey = (r, s) => `${r}|${s}`;
  const stateMap = new Map(states.map((st) => [stateKey(st.rule_id, st.server_id), st]));

  const now = Date.now();

  for (const rule of rules) {
    for (const server of scopeServers(rule, servers, projectsByServer)) {
      const sample = sampleByServer.get(server.id);
      const noSampleSeconds = server.last_seen ? (now - new Date(server.last_seen).getTime()) / 1000 : null;
      const ctx = { noSampleSeconds, expected: expectedByServer.get(server.id) || [] };

      let value;
      if (rule.metric === 'no_sample') {
        if (noSampleSeconds === null) continue; // never reported → not yet monitored
        value = noSampleSeconds;
      } else {
        if (!sample) continue; // offline is covered by the no_sample rule
        value = extractMetric(rule.metric, sample, ctx);
        if (value === null) continue; // metric not applicable on this server
      }

      const st = stateMap.get(stateKey(rule.id, server.id)) || { since: null, firing_incident_id: null };
      const firing = !!st.firing_incident_id;
      let condTrue = compare(value, rule.comparator, rule.threshold);
      // Hysteresis: while firing, stay firing until the value crosses recover_threshold
      if (firing && !condTrue && rule.recover_threshold !== null && rule.recover_threshold !== undefined) {
        condTrue = compare(value, rule.comparator, rule.recover_threshold);
      }

      if (condTrue) {
        const since = st.since ? new Date(st.since).getTime() : now;
        const heldMin = (now - since) / 60000;
        if (!st.since) {
          await q(
            `INSERT INTO rule_state (rule_id, server_id, since, last_value, updated_at)
             VALUES ($1,$2,to_timestamp($3/1000.0),$4,now())
             ON CONFLICT (rule_id, server_id) DO UPDATE SET since = EXCLUDED.since, last_value = EXCLUDED.last_value, updated_at = now()`,
            [rule.id, server.id, now, value]);
        } else {
          await q('UPDATE rule_state SET last_value = $3, updated_at = now() WHERE rule_id = $1 AND server_id = $2',
            [rule.id, server.id, value]);
        }

        if (!firing && heldMin >= Number(rule.duration_min)) {
          // Flapping guard: count recent fires for this (rule, server)
          const { rows: flap } = await q(
            `SELECT count(*)::int AS n FROM incidents
             WHERE rule_id = $1 AND server_id = $2 AND started_at > now() - ($3 || ' minutes')::interval`,
            [rule.id, server.id, String(rule.flap_window_min)]);
          const isFlapping = flap[0].n >= rule.flap_limit;

          const id = newIncidentId();
          const message = `${rule.name}: ${rule.metric} = ${Number(value).toFixed(2)} (${rule.comparator} ${rule.threshold}) on ${server.name} for ${rule.duration_min} min`;
          const { rows: incRows } = await q(
            `INSERT INTO incidents (id, rule_id, rule_name, server_id, severity, status, metric, value, threshold, message)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [id, rule.id, rule.name, server.id, rule.severity, isFlapping ? 'flapping' : 'firing',
             rule.metric, value, rule.threshold, message]);
          await q(
            `UPDATE rule_state SET firing_incident_id = $3, updated_at = now() WHERE rule_id = $1 AND server_id = $2`,
            [rule.id, server.id, id]);

          const channels = Array.isArray(rule.channels) ? rule.channels : [];
          const payload = await buildNotifyPayload(rule, server, incRows[0], isFlapping ? 'alert.flapping' : 'alert.fired');
          if (channels.length) await enqueueNotifications(boss, { incidentId: id, event: payload.event, channelNames: channels, payload });
          log.info?.(`[alert] ${payload.event} ${id} ${rule.name} @ ${server.id} value=${value}`);
        } else if (firing) {
          // still firing → maybe send a reminder
          const { rows: incRows } = await q(
            `SELECT * FROM incidents WHERE id = $1 AND status = 'firing'`, [st.firing_incident_id]);
          const inc = incRows[0];
          if (inc) {
            await q('UPDATE incidents SET value = $2 WHERE id = $1', [inc.id, value]);
            const notif = Array.isArray(inc.notified) ? inc.notified : [];
            const lastAt = notif.length ? Math.max(...notif.map((x) => new Date(x.at).getTime() || 0)) : new Date(inc.started_at).getTime();
            const channels = Array.isArray(rule.channels) ? rule.channels : [];
            if (channels.length && now - lastAt > REMINDER_MIN * 60000) {
              const payload = await buildNotifyPayload(rule, server, { ...inc, value }, 'alert.reminder');
              await enqueueNotifications(boss, { incidentId: inc.id, event: 'alert.reminder', channelNames: channels, payload });
            }
          }
        }
      } else {
        // condition false → resolve if firing, clear state
        if (firing) {
          const { rows: incRows } = await q(
            `UPDATE incidents SET status = 'resolved', resolved_at = now()
             WHERE id = $1 AND status IN ('firing','acknowledged','flapping','silenced') RETURNING *`,
            [st.firing_incident_id]);
          const inc = incRows[0];
          if (inc && inc.status) {
            const channels = Array.isArray(rule.channels) ? rule.channels : [];
            if (channels.length && inc.severity !== 'info') {
              const payload = await buildNotifyPayload(rule, server, { ...inc, value }, 'alert.resolved');
              await enqueueNotifications(boss, { incidentId: inc.id, event: 'alert.resolved', channelNames: channels, payload });
            }
            log.info?.(`[alert] resolved ${st.firing_incident_id} (${rule.name} @ ${server.id})`);
          }
        }
        if (st.since || firing) {
          await q(
            `UPDATE rule_state SET since = NULL, firing_incident_id = NULL, last_value = $3, updated_at = now()
             WHERE rule_id = $1 AND server_id = $2`,
            [rule.id, server.id, value]);
        }
      }
    }
  }

  // Un-silence incidents whose window expired
  await q(
    `UPDATE incidents SET status = 'firing', silenced_until = NULL
     WHERE status = 'silenced' AND silenced_until IS NOT NULL AND silenced_until < now()`);
}

export function startAlertEngine(boss, log = console) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // don't overlap slow ticks
    running = true;
    try {
      await tick(boss, log);
    } catch (e) {
      log.error?.('[alert] tick failed', e);
    } finally {
      running = false;
    }
  }, config.alertTickS * 1000);
  timer.unref?.();
  log.info?.(`[alert] engine started (tick ${config.alertTickS}s)`);
  return timer;
}
