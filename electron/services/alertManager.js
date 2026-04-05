/**
 * Alert Manager Service
 * Evaluates service and container state transitions and fires native
 * macOS notifications for meaningful status changes.
 */

const { Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvent: logActivityEvent } = require('./activityLog');

// --- Configuration ---
const DEBOUNCE_MS = 5000;           // Must be red for 5s before alerting
const DEGRADED_DEBOUNCE_MS = 15000; // Must be yellow for 15s before alerting
const COOLDOWN_MS = 300000;         // 5min per-service cooldown between notifications

const SETTINGS_FILE_PATH = path.join(os.homedir(), '.fere', 'settings.json');
const ALERT_HISTORY_FILE_PATH = path.join(os.homedir(), '.fere', 'alert-history.json');
const MAX_ALERT_HISTORY = 200;
const MAX_ALERT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Alert state per node ---
// Map<nodeId, { previousHealth, previousContainerState, redEnteredAt, redNotified, lastNotifiedAt, name }>
const nodeStates = new Map();
const intentionalStopByPid = new Map();
const intentionalStopByContainerId = new Map();
const INTENTIONAL_STOP_TTL_MS = 30000;

const DISCOVERY_BATCH_WINDOW_MS = 10000;
let discoveryBuffer = [];
let discoveryFlushTimer = null;

function bufferDiscovery(node) {
  discoveryBuffer.push({ node, timestamp: Date.now() });
  if (discoveryFlushTimer) clearTimeout(discoveryFlushTimer);
  discoveryFlushTimer = setTimeout(flushDiscoveryBuffer, DISCOVERY_BATCH_WINDOW_MS);
}

function flushDiscoveryBuffer() {
  discoveryFlushTimer = null;
  if (discoveryBuffer.length === 0) return;

  const pending = discoveryBuffer;
  discoveryBuffer = [];
  const groups = new Map();

  for (const { node } of pending) {
    const project = node.project || node.projectPath || null;
    const key = project || `__individual_${node.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }

  groups.forEach((nodes, key) => {
    if (key.startsWith('__individual_') || nodes.length < 3) {
      for (const node of nodes) {
        recordAlertEvent('service-discovered', node, '', false);
      }
      return;
    }

    const serviceNames = nodes.map((node) => node.name || 'Service');
    const projectName = nodes[0].project || key.split('/').pop() || key;
    logActivityEvent({
      category: 'discovery',
      severity: 'info',
      title: `${nodes.length} services started in ${projectName}`,
      detail: serviceNames.join(', '),
      serviceName: null,
      serviceId: null,
      projectName,
    });

    for (const node of nodes) {
      recordAlertEventHistoryOnly('service-discovered', node);
    }
  });
}

// --- Preferences ---
let cachedPreferences = null;

const DEFAULT_CATEGORY_TOGGLES = { down: true, recovery: true, degraded: true, container: true };

// --- Alert history ---
let alertHistoryWriteQueue = Promise.resolve();
let eventCounter = 0;

function ensureConfigDir() {
  const configDir = path.join(os.homedir(), '.fere');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

function loadPreferences() {
  const defaults = { alertsEnabled: true, categoryToggles: { ...DEFAULT_CATEGORY_TOGGLES } };
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      cachedPreferences = {
        alertsEnabled: parsed.alertsEnabled !== false,
        categoryToggles: {
          down: parsed.categoryToggles?.down !== false,
          recovery: parsed.categoryToggles?.recovery !== false,
          degraded: parsed.categoryToggles?.degraded !== false,
          container: parsed.categoryToggles?.container !== false,
        },
      };
    } else {
      cachedPreferences = defaults;
    }
  } catch (e) {
    cachedPreferences = defaults;
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
 * @returns {{ alertsEnabled: boolean, categoryToggles: { down: boolean, recovery: boolean, degraded: boolean, container: boolean } }}
 */
function getAlertPreferences() {
  if (!cachedPreferences) loadPreferences();
  return {
    alertsEnabled: cachedPreferences.alertsEnabled,
    categoryToggles: { ...cachedPreferences.categoryToggles },
  };
}

/**
 * Set alert preferences and persist to disk.
 * @param {{ alertsEnabled?: boolean, categoryToggles?: object }} prefs
 * @returns {{ success: boolean }}
 */
function setAlertPreferences(prefs) {
  const update = {};
  if (typeof prefs.alertsEnabled === 'boolean') {
    update.alertsEnabled = prefs.alertsEnabled;
  }
  if (prefs.categoryToggles && typeof prefs.categoryToggles === 'object') {
    const existing = cachedPreferences?.categoryToggles || { ...DEFAULT_CATEGORY_TOGGLES };
    const merged = { ...existing };
    for (const key of ['down', 'recovery', 'degraded', 'container']) {
      if (typeof prefs.categoryToggles[key] === 'boolean') {
        merged[key] = prefs.categoryToggles[key];
      }
    }
    update.categoryToggles = merged;
  }
  savePreferences(update);
  return { success: true };
}

// --- Category helpers ---

function typeToCategory(type) {
  if (type === 'container-stopped' || type === 'container-running') return 'container';
  if (type === 'service-discovered' || type === 'service-gone') return 'discovery';
  return type;
}

function isCategoryEnabled(prefs, type) {
  if (!prefs.alertsEnabled) return false;
  const category = typeToCategory(type);
  return prefs.categoryToggles?.[category] !== false;
}

// --- Alert history ---

function readAlertHistory() {
  if (!fs.existsSync(ALERT_HISTORY_FILE_PATH)) return [];
  try {
    const raw = fs.readFileSync(ALERT_HISTORY_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAlertHistory(history) {
  ensureConfigDir();
  const tmp = ALERT_HISTORY_FILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf-8');
  fs.renameSync(tmp, ALERT_HISTORY_FILE_PATH);
}

function recordAlertEventHistoryOnly(type, node) {
  alertHistoryWriteQueue = alertHistoryWriteQueue.then(() => {
    let history = readAlertHistory();
    const cutoff = Date.now() - MAX_ALERT_AGE_MS;
    history = history.filter(e => e.timestamp >= cutoff);

    history.unshift({
      id: `${Date.now()}-${++eventCounter}`,
      timestamp: Date.now(),
      type,
      category: typeToCategory(type),
      serviceName: node.name || 'Service',
      serviceType: node.type || 'service',
      nodeId: node.id,
      details: '',
      notified: false,
    });

    if (history.length > MAX_ALERT_HISTORY) {
      history = history.slice(0, MAX_ALERT_HISTORY);
    }

    writeAlertHistory(history);
  }).catch(err => {
    console.error('[AlertManager] Error recording alert event (history only):', err);
  });
}

function recordAlertEvent(type, node, details, notified) {
  alertHistoryWriteQueue = alertHistoryWriteQueue.then(() => {
    let history = readAlertHistory();
    const cutoff = Date.now() - MAX_ALERT_AGE_MS;
    history = history.filter(e => e.timestamp >= cutoff);

    history.unshift({
      id: `${Date.now()}-${++eventCounter}`,
      timestamp: Date.now(),
      type,
      category: typeToCategory(type),
      serviceName: node.name || 'Service',
      serviceType: node.type || 'service',
      nodeId: node.id,
      details: details || '',
      notified,
    });

    if (history.length > MAX_ALERT_HISTORY) {
      history = history.slice(0, MAX_ALERT_HISTORY);
    }

    writeAlertHistory(history);
  }).catch(err => {
    console.error('[AlertManager] Error recording alert event:', err);
  });

  const activityMap = {
    down: { category: 'crash', severity: 'critical' },
    recovery: { category: 'recovery', severity: 'info' },
    degraded: { category: 'anomaly', severity: 'warning' },
    'container-stopped': { category: 'crash', severity: 'critical' },
    'container-running': { category: 'recovery', severity: 'info' },
    'service-discovered': { category: 'discovery', severity: 'info' },
    'service-gone': { category: 'removal', severity: 'warning' },
  };
  const mapped = activityMap[type];
  if (mapped) {
    const serviceName = node.name || 'Service';
    const titleMap = {
      down: `${serviceName} went down`,
      recovery: `${serviceName} recovered`,
      degraded: `${serviceName} is degraded`,
      'container-stopped': `Container ${serviceName} stopped${details ? ' (' + details + ')' : ''}`,
      'container-running': `Container ${serviceName} is running`,
      'service-discovered': `${serviceName} appeared`,
      'service-gone': `${serviceName} disappeared`,
    };
    logActivityEvent({
      category: mapped.category,
      severity: mapped.severity,
      title: titleMap[type] || `${serviceName}: ${type}`,
      detail: details || '',
      serviceName,
      serviceId: node.id || null,
      projectName: node.project || null,
    });
  }
}

function getAlertHistory() {
  try {
    const cutoff = Date.now() - MAX_ALERT_AGE_MS;
    return readAlertHistory().filter(e => e.timestamp >= cutoff);
  } catch {
    return [];
  }
}

function clearAlertHistory() {
  return (alertHistoryWriteQueue = alertHistoryWriteQueue.then(() => {
    writeAlertHistory([]);
    return { success: true };
  }).catch(err => ({ success: false, error: err.message })));
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
      // First time seeing this node — initialize and record discovery
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
      bufferDiscovery(node);
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
        if (!isIntentionalStop(node, now)) {
          const details = node.type === 'database' ? 'check DB process/container' : '';
          const shouldNotify = isCategoryEnabled(prefs, 'down');
          if (shouldNotify) fireNotification('down', node, details);
          recordAlertEvent('down', node, details, shouldNotify);
          prev.lastNotifiedAt = now;
          prev.redNotified = true;
        }
      }

    } else if (currentHealth === 'green' && previousHealth === 'red') {
      // Recovered — notify only if was red long enough
      const timeSinceRedEntered = now - prev.redEnteredAt;
      if (timeSinceRedEntered >= DEBOUNCE_MS && canNotify(prev, now)) {
        const shouldNotify = isCategoryEnabled(prefs, 'recovery');
        if (shouldNotify) fireNotification('recovery', node);
        recordAlertEvent('recovery', node, '', shouldNotify);
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
          canNotify(prev, now)
        ) {
          const shouldNotify = isCategoryEnabled(prefs, 'degraded');
          if (shouldNotify) fireNotification('degraded', node);
          recordAlertEvent('degraded', node, '', shouldNotify);
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
        const shouldNotify = isCategoryEnabled(prefs, 'container-stopped');
        if (shouldNotify) fireNotification('container-stopped', node, currentContainerState);
        recordAlertEvent('container-stopped', node, currentContainerState, shouldNotify);
        prev.lastNotifiedAt = now;
      } else if (
        previousContainerState !== 'running' &&
        currentContainerState === 'running'
      ) {
        const shouldNotify = isCategoryEnabled(prefs, 'container-running');
        if (shouldNotify) fireNotification('container-running', node);
        recordAlertEvent('container-running', node, '', shouldNotify);
        prev.lastNotifiedAt = now;
      }
    }

    prev.previousContainerState = currentContainerState;
    // Keep name in sync
    prev.name = node.name;
  }

  // Record and clean up nodes that disappeared from the graph
  for (const [nodeId, state] of nodeStates) {
    if (!currentNodeIds.has(nodeId)) {
      recordAlertEvent('service-gone', { id: nodeId, name: state.name, type: 'service' }, '', false);
      nodeStates.delete(nodeId);
    }
  }
}

module.exports = {
  initAlertManager,
  evaluateAlerts,
  getAlertPreferences,
  setAlertPreferences,
  getAlertHistory,
  clearAlertHistory,
  markIntentionalStopForPid,
  markIntentionalStopForContainer,
};
