// pg_boss consumer: delivers one notification (one channel) per job,
// with retries + dead-letter on final failure.
import { q } from '../db/pool.js';
import { deliver } from './channels.js';

export const NOTIFY_QUEUE = 'notify';
export const RETRY_LIMIT = 5;

export async function enqueueNotifications(boss, { incidentId, event, channelNames, payload }) {
  for (const name of channelNames || []) {
    await boss.send(NOTIFY_QUEUE, { incident_id: incidentId, event, channel: name, payload }, {
      retryLimit: RETRY_LIMIT,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 60,
    });
  }
}

export function startNotifier(boss, log = console) {
  return boss.work(NOTIFY_QUEUE, { teamSize: 2 }, async (job) => {
    const { incident_id, event, channel, payload } = job.data;
    const { rows } = await q('SELECT * FROM notify_channels WHERE name = $1 AND enabled', [channel]);
    const ch = rows[0];
    if (!ch) {
      log.warn?.(`[notify] channel "${channel}" missing or disabled — dropping`);
      return;
    }
    try {
      const res = await deliver(ch, payload);
      await q(
        `INSERT INTO notification_log (incident_id, channel, event, success, response) VALUES ($1,$2,$3,true,$4)`,
        [incident_id || null, channel, event, res]);
      if (incident_id) {
        await q(
          `UPDATE incidents SET notified = notified || $2::jsonb WHERE id = $1`,
          [incident_id, JSON.stringify([{ channel, event, at: new Date().toISOString() }])]);
      }
    } catch (e) {
      await q(
        `INSERT INTO notification_log (incident_id, channel, event, success, response) VALUES ($1,$2,$3,false,$4)`,
        [incident_id || null, channel, event, { error: String(e.message || e) }]);
      if ((job.retrycount ?? 0) >= RETRY_LIMIT - 1) {
        await q(
          `INSERT INTO notification_dead_letter (incident_id, channel, event, payload, error) VALUES ($1,$2,$3,$4,$5)`,
          [incident_id || null, channel, event, payload, String(e.message || e)]);
        log.error?.(`[notify] dead-lettered ${channel} for ${incident_id}: ${e.message}`);
        return; // stop retrying
      }
      throw e; // let pg_boss retry with backoff
    }
  });
}
