/**
 * Alert Manager Service
 * Evaluates service and container state transitions and fires native
 * macOS notifications for meaningful status changes.
 */

const { Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Configuration ---
const DEBOUNCE_MS = 5000;           // Must be red for 5s before alerting
const DEGRADED_DEBOUNCE_MS = 15000; // Must be yellow for 15s before alerting
const COOLDOWN_MS = 300000;         // 5min per-service cooldown between notifications

const SETTINGS_FILE_PATH = path.join(os.homedir(), '.fere', 'settings.json');

// --- Alert state per node ---
// Map<nodeId, { previousHealth, previousContainerState, redEnteredAt, redNotified, lastNotifiedAt, name }>
const nodeStates = new Map();
const intentionalStopByPid = new Map();
const intentionalStopByContainerId = new Map();
const INTENTIONAL_STOP_TTL_MS = 30000;

// --- Preferences ---
let cachedPreferences = null;

function ensureConfigDir() {
  const configDir = path.join(os.homedir(), '.fere');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

function loadPreferences() {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      cachedPreferences = {
        alertsEnabled: parsed.alertsEnabled !== false, // default true
      };
    } else {
      cachedPreferences = { alertsEnabled: true };
    }
  } catch (e) {
    cachedPreferences = { alertsEnabled: true };
  }
  return cachedPreferences;
}

function savePreferences(prefs) {
  ensureConfigDir();
  let existing = {};
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      existing = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
    }
  } catch (e) { /* start fresh */ }
  const merged = { ...existing, ...prefs };
  // Atomic write: write to temp file then rename
  const tmp = SETTINGS_FILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, SETTINGS_FILE_PATH);
  cachedPreferences = { ...cachedPreferences, ...prefs };
}

// --- Public API ---

/**
 * Initialize alert manager, loading preferences from disk.
 */
function initAlertManager() {
  loadPreferences();
}

/**
 * Get current alert preferences.
 * @returns {{ alertsEnabled: boolean }}
 */
function getAlertPreferences() {
  if (!cachedPreferences) loadPreferences();
  return { alertsEnabled: cachedPreferences.alertsEnabled };
}

/**
 * Set alert preferences and persist to disk.
 * @param {{ alertsEnabled?: boolean }} prefs
 * @returns {{ success: boolean }}
 */
function setAlertPreferences(prefs) {
  const update = {};
  if (typeof prefs.alertsEnabled === 'boolean') {
    update.alertsEnabled = prefs.alertsEnabled;
  }
  savePreferences(update);
  return { success: true };
}

/**
 * Check if a node was intentionally stopped (best-effort heuristic).
 * Docker containers with state 'exited' or 'dead' are considered intentional.
 */
function pruneIntentionalStops(now) {
  for (const [pid, until] of intentionalStopByPid.entries()) {
    if (until <= now) intentionalStopByPid.delete(pid);
  }
  for (const [containerId, until] of intentionalStopByContainerId.entries()) {
    if (until <= now) intentionalStopByContainerId.delete(containerId);
  }
}

function isIntentionalStop(node, now) {
  pruneIntentionalStops(now);
  if (node.pid && intentionalStopByPid.has(node.pid)) return true;
  if (node.containerId && intentionalStopByContainerId.has(node.containerId)) return true;
  return false;
}

function markIntentionalStopForPid(pid, ttlMs = INTENTIONAL_STOP_TTL_MS) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  intentionalStopByPid.set(pid, Date.now() + ttlMs);
}

function markIntentionalStopForContainer(containerId, ttlMs = INTENTIONAL_STOP_TTL_MS) {
  if (!containerId || typeof containerId !== 'string') return;
  intentionalStopByContainerId.set(containerId, Date.now() + ttlMs);
}

/**
 * Fire a native macOS notification.
 * @param {'crash'|'recovery'} type
 * @param {string} serviceName
 */
function serviceKindLabel(node) {
  switch (node.type) {
    case 'database': return 'Database';
    case 'cache': return 'Cache';
    case 'broker': return 'Broker';
    default: return 'Service';
  }
}

function shouldIgnoreNode(node) {
  return node.isGhost || node.type === 'external';
}

function canNotify(prev, now) {
  return now - prev.lastNotifiedAt >= COOLDOWN_MS;
}

function fireNotification(type, node, details = '') {
  if (!Notification.isSupported()) return;
  const serviceName = node.name || 'Service';
  const kind = serviceKindLabel(node);
  const suffix = details ? ` (${details})` : '';

  if (type === 'down') {
    new Notification({
      title: `${kind} Down`,
      body: `${serviceName} is down${suffix}`,
      silent: false,
    }).show();
  } else if (type === 'recovery') {
    new Notification({
      title: `${kind} Recovered`,
      body: `${serviceName} is back online${suffix}`,
      silent: false,
    }).show();
  } else if (type === 'degraded') {
    new Notification({
      title: `${kind} Degraded`,
      body: `${serviceName} is responding slowly or idle${suffix}`,
      silent: false,
    }).show();
  } else if (type === 'container-stopped') {
    new Notification({
      title: 'Container Stopped',
      body: `${serviceName} changed state to ${details || 'stopped'}`,
      silent: false,
    }).show();
  } else if (type === 'container-running') {
    new Notification({
      title: 'Container Running',
      body: `${serviceName} is running again`,
      silent: false,
    }).show();
  }
}

/**
 * Evaluate health transitions for all nodes in the current snapshot.
 * Called from main.js snapshot handler on every emission.
 * @param {Array<{id: string, name: string, healthStatus: string, containerState?: string, isDockerContainer?: boolean}>} nodes
 */
function evaluateAlerts(nodes) {
  const prefs = getAlertPreferences();
  const now = Date.now();
  const currentNodeIds = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    if (shouldIgnoreNode(node)) continue;

    const prev = nodeStates.get(node.id);

    if (!prev) {
      // First time seeing this node — initialize, no alert
      nodeStates.set(node.id, {
        previousHealth: node.healthStatus,
        previousContainerState: node.containerState || null,
        redEnteredAt: node.healthStatus === 'red' ? now : 0,
        redNotified: false,
        yellowEnteredAt: node.healthStatus === 'yellow' ? now : 0,
        yellowNotified: false,
        lastNotifiedAt: 0,
        name: node.name,
      });
      continue;
    }

    const currentHealth = node.healthStatus;
    const previousHealth = prev.previousHealth;

    if (currentHealth === 'red' && previousHealth !== 'red') {
      // Just entered red — record timestamp, start debounce
      prev.redEnteredAt = now;
      prev.redNotified = false;
      prev.previousHealth = 'red';

    } else if (currentHealth === 'red' && previousHealth === 'red') {
      // Still in red — notify once after debounce
      const timeSinceRedEntered = now - prev.redEnteredAt;
      if (!prev.redNotified && timeSinceRedEntered >= DEBOUNCE_MS && canNotify(prev, now)) {
        if (prefs.alertsEnabled && !isIntentionalStop(node, now)) {
          fireNotification('down', node, node.type === 'database' ? 'check DB process/container' : '');
          prev.lastNotifiedAt = now;
          prev.redNotified = true;
        }
      }

    } else if (currentHealth === 'green' && previousHealth === 'red') {
      // Recovered — notify only if was red long enough
      const timeSinceRedEntered = now - prev.redEnteredAt;
      if (timeSinceRedEntered >= DEBOUNCE_MS && prefs.alertsEnabled && canNotify(prev, now)) {
        fireNotification('recovery', node);
        prev.lastNotifiedAt = now;
      }
      prev.redEnteredAt = 0;
      prev.redNotified = false;
      prev.previousHealth = 'green';

    } else {
      // Yellow (degraded) handling with debounce
      if (currentHealth === 'yellow' && previousHealth !== 'yellow') {
        // Just entered yellow — start debounce
        prev.yellowEnteredAt = now;
        prev.yellowNotified = false;
      } else if (currentHealth === 'yellow' && previousHealth === 'yellow') {
        // Still yellow — notify once after debounce
        const timeSinceYellowEntered = now - prev.yellowEnteredAt;
        if (
          !prev.yellowNotified &&
          timeSinceYellowEntered >= DEGRADED_DEBOUNCE_MS &&
          canNotify(prev, now) &&
          prefs.alertsEnabled
        ) {
          fireNotification('degraded', node);
          prev.lastNotifiedAt = now;
          prev.yellowNotified = true;
        }
      }

      if (currentHealth !== 'yellow') {
        prev.yellowEnteredAt = 0;
        prev.yellowNotified = false;
      }

      // Any other transition
      prev.previousHealth = currentHealth;
      if (currentHealth !== 'red') {
        prev.redEnteredAt = 0;
        prev.redNotified = false;
      }
    }

    const previousContainerState = prev.previousContainerState || null;
    const currentContainerState = node.containerState || null;
    if (
      prefs.alertsEnabled &&
      node.isDockerContainer &&
      previousContainerState &&
      currentContainerState &&
      previousContainerState !== currentContainerState &&
      canNotify(prev, now)
    ) {
      if (
        previousContainerState === 'running' &&
        ['exited', 'dead', 'paused', 'restarting'].includes(currentContainerState) &&
        !isIntentionalStop(node, now)
      ) {
        fireNotification('container-stopped', node, currentContainerState);
        prev.lastNotifiedAt = now;
      } else if (
        previousContainerState !== 'running' &&
        currentContainerState === 'running'
      ) {
        fireNotification('container-running', node);
        prev.lastNotifiedAt = now;
      }
    }

    prev.previousContainerState = currentContainerState;
    // Keep name in sync
    prev.name = node.name;
  }

  // Clean up nodes that disappeared from the graph
  for (const [nodeId] of nodeStates) {
    if (!currentNodeIds.has(nodeId)) {
      nodeStates.delete(nodeId);
    }
  }
}

module.exports = {
  initAlertManager,
  evaluateAlerts,
  getAlertPreferences,
  setAlertPreferences,
  markIntentionalStopForPid,
  markIntentionalStopForContainer,
};
