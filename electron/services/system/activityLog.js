/**
 * Activity Log Service
 * Centralized event logger for the Activity tab.
 * Stores events in ~/.fere/activity-log.json (max 200 events, 4h retention).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events");

const LOG_FILE_PATH = path.join(os.homedir(), ".fere", "activity-log.json");
const MAX_EVENTS = 200;
const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const FLUSH_DEBOUNCE_MS = 2000;

// In-memory event store
let events = [];
let flushTimer = null;
let eventCounter = 0;

// Event emitter for push notifications to renderer
const activityEmitter = new EventEmitter();

// --- Persistence ---

function ensureConfigDir() {
  const configDir = path.join(os.homedir(), ".fere");
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

function loadEvents() {
  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      const raw = fs.readFileSync(LOG_FILE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        events = parsed;
        purgeOldEvents();
        return;
      }
    }
  } catch (err) {
    console.error("[ActivityLog] Failed to load events:", err);
  }
  events = [];
}

function flushEvents() {
  ensureConfigDir();
  try {
    const tmp = LOG_FILE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(events), "utf-8");
    fs.renameSync(tmp, LOG_FILE_PATH);
  } catch (err) {
    console.error("[ActivityLog] Failed to flush events:", err);
  }
}

function scheduleDebouncedFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushEvents();
  }, FLUSH_DEBOUNCE_MS);
}

function purgeOldEvents() {
  const cutoff = Date.now() - MAX_AGE_MS;
  events = events.filter((e) => e.timestamp >= cutoff);
  if (events.length > MAX_EVENTS) {
    events = events.slice(0, MAX_EVENTS);
  }
}

// --- Event creation ---

function generateId() {
  return `${Date.now()}-${++eventCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Find correlated events: same serviceName or connected service within 5 seconds.
 * @param {object} newEvent
 * @param {Set<string>} [connectedServices] - service names connected via graph edges
 */
function findCorrelatedIds(newEvent, connectedServices) {
  const related = [];
  const windowMs = 5000;
  const recentEvents = events.slice(0, 10);

  for (const evt of recentEvents) {
    if (Math.abs(newEvent.timestamp - evt.timestamp) > windowMs) continue;

    const sameService = newEvent.serviceName && evt.serviceName === newEvent.serviceName;
    const connectedService =
      connectedServices && evt.serviceName && connectedServices.has(evt.serviceName);

    if (sameService || connectedService) {
      related.push(evt.id);
    }
  }
  return related;
}

/**
 * Log an activity event.
 * @param {object} params
 * @param {string} params.category - 'crash' | 'recovery' | 'anomaly' | 'sentinel' | 'discovery' | 'removal' | 'topology' | 'user-action'
 * @param {string} params.severity - 'critical' | 'warning' | 'info'
 * @param {string} params.title
 * @param {string} [params.detail]
 * @param {string|null} [params.serviceName]
 * @param {string|null} [params.serviceId]
 * @param {string|null} [params.projectName]
 * @param {Set<string>} [params.connectedServices] - for correlation
 */
function logEvent(params) {
  const event = {
    id: generateId(),
    timestamp: Date.now(),
    category: params.category,
    severity: params.severity,
    title: params.title,
    detail: params.detail || "",
    serviceName: params.serviceName || null,
    serviceId: params.serviceId || null,
    projectName: params.projectName || null,
    relatedEvents: [],
  };

  event.relatedEvents = findCorrelatedIds(event, params.connectedServices);

  // Also update relatedEvents on the correlated events (bidirectional)
  for (const relId of event.relatedEvents) {
    const rel = events.find((e) => e.id === relId);
    if (rel && !rel.relatedEvents.includes(event.id)) {
      rel.relatedEvents.push(event.id);
    }
  }

  events.unshift(event);
  purgeOldEvents();
  scheduleDebouncedFlush();

  // Emit for real-time push to renderer
  activityEmitter.emit("event", event);

  return event;
}

// --- Query ---

/**
 * Get activity log events with optional filters.
 * @param {object} [options]
 * @param {number} [options.since] - only events after this timestamp
 * @param {string[]} [options.categories] - filter by categories
 * @param {string} [options.projectName] - filter by project
 * @param {number} [options.limit] - max events to return
 */
function getActivityLog(options = {}) {
  let result = events;

  if (options.since) {
    result = result.filter((e) => e.timestamp >= options.since);
  }
  if (options.categories && options.categories.length > 0) {
    const cats = new Set(options.categories);
    result = result.filter((e) => cats.has(e.category));
  }
  if (options.projectName) {
    result = result.filter((e) => e.projectName === options.projectName);
  }
  if (options.limit && options.limit > 0) {
    result = result.slice(0, options.limit);
  }

  return result;
}

// --- Init / Cleanup ---

function initActivityLog() {
  loadEvents();
}

function shutdownActivityLog() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushEvents();
}

module.exports = {
  initActivityLog,
  shutdownActivityLog,
  logEvent,
  getActivityLog,
  activityEmitter,
};
