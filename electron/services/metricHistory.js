/**
 * Metric History Service
 * Per-service CPU/memory ring buffer for the Activity tab resource charts.
 * 720 samples per service (1 hour at 5s intervals).
 */

const { logEvent } = require('./activityLog');

const RING_SIZE = 720; // 1 hour at 5s intervals
const ANOMALY_CHECK_INTERVAL_MS = 60000; // check anomalies every 60s
const ANOMALY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per service per anomaly type

// Map<serviceName, { samples: Array<{ t, cpu, mem }>, head: number, count: number }>
const buffers = new Map();

// Anomaly state tracking
const anomalyState = new Map();
// Map<serviceName, { lastMemCheck: number, lastCpuSpikeStart: number, lastIdleStart: number, reported: Set<string> }>

let lastAnomalyCheck = 0;

/**
 * Push a metric sample for a service.
 * @param {string} serviceName
 * @param {number} cpu - CPU percentage
 * @param {number} mem - Memory in MB
 * @param {string|null} [projectName]
 * @param {string|null} [serviceId]
 */
function pushSample(serviceName, cpu, mem, projectName, serviceId) {
  if (!buffers.has(serviceName)) {
    buffers.set(serviceName, {
      samples: new Array(RING_SIZE).fill(null),
      head: 0,
      count: 0,
    });
  }

  const buf = buffers.get(serviceName);
  buf.samples[buf.head] = { t: Date.now(), cpu, mem };
  buf.head = (buf.head + 1) % RING_SIZE;
  if (buf.count < RING_SIZE) buf.count++;

  // Store metadata for anomaly detection
  if (!anomalyState.has(serviceName)) {
    anomalyState.set(serviceName, {
      projectName,
      serviceId,
      lastCpuHighStart: 0,
      cpuHighReported: false,
      lastIdleStart: 0,
      idleReported: false,
    });
  }
  const state = anomalyState.get(serviceName);
  state.projectName = projectName;
  state.serviceId = serviceId;
}

/**
 * Get ordered samples for a service (oldest to newest).
 */
function getSamples(serviceName) {
  const buf = buffers.get(serviceName);
  if (!buf) return [];

  const result = [];
  const start = buf.count < RING_SIZE ? 0 : buf.head;
  for (let i = 0; i < buf.count; i++) {
    const idx = (start + i) % RING_SIZE;
    if (buf.samples[idx]) {
      result.push(buf.samples[idx]);
    }
  }
  return result;
}

/**
 * Get all metric history for the renderer.
 * @returns {{ [serviceName]: { samples: Array<{ t, cpu, mem }> } }}
 */
function getMetricHistory() {
  const result = {};
  for (const [name, buf] of buffers) {
    const state = anomalyState.get(name);
    result[name] = { samples: getSamples(name), projectName: state?.projectName || null };
  }
  return result;
}

/**
 * Run anomaly detection on all tracked services.
 * Called periodically (not on every sample to avoid overhead).
 * @param {number} [connectionCountByService] - Map<serviceName, number> of active connections
 */
function checkAnomalies(connectionCountByService) {
  const now = Date.now();
  if (now - lastAnomalyCheck < ANOMALY_CHECK_INTERVAL_MS) return;
  lastAnomalyCheck = now;

  for (const [serviceName, buf] of buffers) {
    if (buf.count < 6) continue; // need some history

    const samples = getSamples(serviceName);
    const state = anomalyState.get(serviceName);
    if (!state) continue;

    // --- Memory growth: 3x increase over 30 minutes ---
    checkMemoryGrowth(serviceName, samples, state);

    // --- CPU spike: above 80% for 2+ minutes ---
    checkCpuSpike(serviceName, samples, state, now);
  }
}

function checkMemoryGrowth(serviceName, samples, state) {
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  const oldSamples = samples.filter(s => s.t <= thirtyMinAgo + 60000 && s.t >= thirtyMinAgo - 60000);
  if (oldSamples.length === 0) return;

  const oldMem = oldSamples.reduce((sum, s) => sum + s.mem, 0) / oldSamples.length;
  const recentSamples = samples.slice(-6);
  const currentMem = recentSamples.reduce((sum, s) => sum + s.mem, 0) / recentSamples.length;

  const now = Date.now();
  if (oldMem > 0 && currentMem > oldMem * 3 && (!state.lastMemAnomalyAt || now - state.lastMemAnomalyAt >= ANOMALY_COOLDOWN_MS)) {
    state.lastMemAnomalyAt = now;
    logEvent({
      category: 'anomaly',
      severity: 'warning',
      title: `${serviceName} memory grew ${Math.round(currentMem / oldMem)}x in 30 min`,
      detail: `Memory increased from ${Math.round(oldMem)}MB to ${Math.round(currentMem)}MB over the last 30 minutes.`,
      serviceName,
      serviceId: state.serviceId,
      projectName: state.projectName,
    });
  }
}

function checkCpuSpike(serviceName, samples, state, now) {
  const recentSamples = samples.slice(-24); // ~2 minutes at 5s intervals
  if (recentSamples.length < 24) return;

  const allHigh = recentSamples.every(s => s.cpu > 80);

  if (allHigh && !state.cpuHighReported && (!state.lastCpuAnomalyAt || now - state.lastCpuAnomalyAt >= ANOMALY_COOLDOWN_MS)) {
    state.cpuHighReported = true;
    state.lastCpuAnomalyAt = now;
    logEvent({
      category: 'anomaly',
      severity: 'warning',
      title: `${serviceName} CPU above 80% for 2+ minutes`,
      detail: `CPU has been sustained above 80% (avg ${Math.round(recentSamples.reduce((s, x) => s + x.cpu, 0) / recentSamples.length)}%).`,
      serviceName,
      serviceId: state.serviceId,
      projectName: state.projectName,
    });
  } else if (!allHigh) {
    state.cpuHighReported = false;
  }
}

/**
 * Feed metric data from a snapshot's graph nodes.
 * @param {Array<{ name, id, cpu, memory, project }>} nodes
 */
function feedFromSnapshot(nodes) {
  for (const node of nodes) {
    if (!node.name || node.isGhost) continue;
    pushSample(node.name, node.cpu || 0, node.memory || 0, node.project || null, node.id || null);
  }
}

/**
 * Clean up buffers for services no longer present.
 * @param {Set<string>} activeServiceNames
 */
function pruneStaleServices(activeServiceNames) {
  for (const name of buffers.keys()) {
    if (!activeServiceNames.has(name)) {
      buffers.delete(name);
      anomalyState.delete(name);
    }
  }
}

module.exports = {
  pushSample,
  getSamples,
  getMetricHistory,
  checkAnomalies,
  feedFromSnapshot,
  pruneStaleServices,
};
