/**
 * Health Tracker Service
 * Tracks service health states (green/yellow/red) based on activity and presence
 */

// Time thresholds in milliseconds
const ACTIVITY_THRESHOLD = 30000; // 30 seconds - consider active if had connections within this time
const STALE_THRESHOLD = 10000; // 10 seconds - consider stale if not seen within this time

// Track last seen time per PID
const lastSeenByPid = new Map();

// Track last activity (connection) time per PID
const lastActivityByPid = new Map();
// Track last compute activity (CPU usage) time per PID
const lastCpuActiveByPid = new Map();

// Track previously known PIDs (to detect crashed processes)
const knownPids = new Set();

/**
 * Update tracking data for the current snapshot
 * @param {Object} snapshot - Current system snapshot with processes, ports, connections
 */
function updateHealthTracking(snapshot) {
  const now = Date.now();
  const { processes, ports, connections } = snapshot;

  // Get all current PIDs from processes
  const currentPids = new Set();
  for (let i = 0; i < processes.length; i++) {
    currentPids.add(processes[i].pid);
  }

  // Get PIDs that have listening ports
  const listeningPids = new Set();
  for (let i = 0; i < ports.length; i++) {
    listeningPids.add(ports[i].pid);
  }

  // Update lastSeen for all visible processes (not only listeners).
  // System services often don't expose listening ports.
  for (const pid of currentPids) {
    lastSeenByPid.set(pid, now);
    knownPids.add(pid);
  }

  // Treat non-trivial CPU usage as active work for non-network/system services.
  // Keep threshold conservative to avoid status jitter from scheduler noise.
  for (let i = 0; i < processes.length; i++) {
    const proc = processes[i];
    if (proc.cpu >= 0.3) {
      lastCpuActiveByPid.set(proc.pid, now);
    }
  }

  // Update lastActivity for PIDs with established connections
  for (let i = 0; i < connections.length; i++) {
    const pid = connections[i].pid;
    if (listeningPids.has(pid) || currentPids.has(pid)) {
      lastActivityByPid.set(pid, now);
    }
  }

  // Clean up very old entries (older than 5 minutes) to prevent memory leaks
  const cleanupThreshold = now - 300000; // 5 minutes
  for (const [pid, time] of lastSeenByPid) {
    if (time < cleanupThreshold) {
      lastSeenByPid.delete(pid);
      lastActivityByPid.delete(pid);
      lastCpuActiveByPid.delete(pid);
      knownPids.delete(pid);
    }
  }
}

/**
 * Calculate health status for a given node
 * @param {number} pid - Process ID
 * @param {boolean} isListening - Whether the process has listening ports
 * @param {boolean} hasConnections - Whether the process currently has connections
 * @returns {{ healthStatus: 'green' | 'yellow' | 'red', lastSeen: number }}
 */
function getHealthStatus(pid, isListening, hasConnections, process = null) {
  const now = Date.now();
  const lastSeen = lastSeenByPid.get(pid) || now;
  const lastActivity = lastActivityByPid.get(pid) || 0;
  const lastCpuActive = lastCpuActiveByPid.get(pid) || 0;

  // External nodes (pid = -1) are always yellow (we can't track their health)
  if (pid === -1) {
    return { healthStatus: "yellow", lastSeen: now };
  }

  // Check if the process is still being seen
  const timeSinceLastSeen = now - lastSeen;

  // Red: was seen recently but no longer in process list
  if (timeSinceLastSeen > STALE_THRESHOLD) {
    return { healthStatus: "red", lastSeen };
  }

  // If listening and has recent activity -> green
  if (isListening) {
    const timeSinceLastActivity = now - lastActivity;
    if (hasConnections || timeSinceLastActivity < ACTIVITY_THRESHOLD) {
      return { healthStatus: "green", lastSeen };
    }
    // Listening but no recent activity -> yellow
    return { healthStatus: "yellow", lastSeen };
  }

  // Non-listening processes: use CPU bursts as "active" signal.
  const timeSinceLastCpuActive = now - lastCpuActive;
  const hasRecentCpuActivity =
    timeSinceLastCpuActive < ACTIVITY_THRESHOLD || (process && process.cpu >= 0.3);
  if (hasConnections || hasRecentCpuActivity) {
    return { healthStatus: "green", lastSeen };
  }

  return { healthStatus: "yellow", lastSeen };
}

/**
 * Check if a PID was previously known (for detecting crashed services)
 * @param {number} pid - Process ID
 * @returns {boolean}
 */
function wasPreviouslyKnown(pid) {
  return knownPids.has(pid);
}

/**
 * Get all PIDs that were previously seen but are now gone (potentially crashed)
 * @param {Set<number>} currentPids - Set of currently visible PIDs
 * @returns {Array<{pid: number, lastSeen: number}>}
 */
function getStaleServices(currentPids) {
  const now = Date.now();
  const stale = [];

  for (const pid of knownPids) {
    if (!currentPids.has(pid)) {
      const lastSeen = lastSeenByPid.get(pid) || 0;
      const timeSinceLastSeen = now - lastSeen;
      // Only include if within stale window (not too old)
      if (timeSinceLastSeen < 60000) {
        // 1 minute window
        stale.push({ pid, lastSeen });
      }
    }
  }

  return stale;
}

/**
 * Clear all tracking data (useful for testing)
 */
function resetHealthTracking() {
  lastSeenByPid.clear();
  lastActivityByPid.clear();
  lastCpuActiveByPid.clear();
  knownPids.clear();
}

module.exports = {
  updateHealthTracking,
  getHealthStatus,
  wasPreviouslyKnown,
  getStaleServices,
  resetHealthTracking,
};
