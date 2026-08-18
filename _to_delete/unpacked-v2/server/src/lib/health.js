import { config } from '../config.js';

/**
 * Health of one server:
 *   offline  — no sample for > offlineFactor × interval
 *   critical — any active critical incident
 *   warning  — any active warning incident
 *   online   — recent sample, no active incidents
 */
export function computeHealth({ last_seen, activeSeverities = [] }) {
  const offlineMs = config.offlineFactor * config.sampleIntervalS * 1000;
  if (!last_seen || Date.now() - new Date(last_seen).getTime() > offlineMs) return 'offline';
  if (activeSeverities.includes('critical')) return 'critical';
  if (activeSeverities.includes('warning')) return 'warning';
  return 'online';
}
