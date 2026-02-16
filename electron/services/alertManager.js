/**
 * Alert Manager Service
 * Evaluates health transitions and fires native macOS notifications
 * for service crashes (non-red → red) and recoveries (red → green).
 */

const { Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Configuration ---
const DEBOUNCE_MS = 5000;   // Must be red for 5s before alerting
const COOLDOWN_MS = 60000;  // 60s per-service cooldown between notifications

const SETTINGS_FILE_PATH = path.join(os.homedir(), '.fere', 'settings.json');

// --- Alert state per node ---
// Map<nodeId, { previousHealth, redEnteredAt, lastNotifiedAt, name }>
const nodeStates = new Map();

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
  fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
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
function isIntentionalStop(node) {
  if (node.isDockerContainer && (node.containerState === 'exited' || node.containerState === 'dead')) {
    return true;
  }
  return false;
}

/**
 * Fire a native macOS notification.
 * @param {'crash'|'recovery'} type
 * @param {string} serviceName
 */
function fireNotification(type, serviceName) {
  if (!Notification.isSupported()) return;

  if (type === 'crash') {
    new Notification({
      title: 'Service Down',
      body: `${serviceName} has become unresponsive`,
      silent: false,
    }).show();
  } else if (type === 'recovery') {
    new Notification({
      title: 'Service Recovered',
      body: `${serviceName} is back online`,
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
    const prev = nodeStates.get(node.id);

    if (!prev) {
      // First time seeing this node — initialize, no alert
      nodeStates.set(node.id, {
        previousHealth: node.healthStatus,
        redEnteredAt: node.healthStatus === 'red' ? now : 0,
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
      prev.previousHealth = 'red';

    } else if (currentHealth === 'red' && previousHealth === 'red') {
      // Still in red — check debounce and cooldown
      const timeSinceRedEntered = now - prev.redEnteredAt;
      const timeSinceLastNotified = now - prev.lastNotifiedAt;

      if (timeSinceRedEntered >= DEBOUNCE_MS && timeSinceLastNotified >= COOLDOWN_MS) {
        if (prefs.alertsEnabled && !isIntentionalStop(node)) {
          fireNotification('crash', node.name);
          prev.lastNotifiedAt = now;
        }
      }

    } else if (currentHealth === 'green' && previousHealth === 'red') {
      // Recovered — notify only if was red long enough
      const timeSinceRedEntered = now - prev.redEnteredAt;
      if (timeSinceRedEntered >= DEBOUNCE_MS && prefs.alertsEnabled) {
        fireNotification('recovery', node.name);
        prev.lastNotifiedAt = now;
      }
      prev.redEnteredAt = 0;
      prev.previousHealth = 'green';

    } else {
      // Any other transition
      prev.previousHealth = currentHealth;
      if (currentHealth !== 'red') {
        prev.redEnteredAt = 0;
      }
    }

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
};
