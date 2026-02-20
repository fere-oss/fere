const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_FILE_PATH = path.join(os.homedir(), '.fere', 'request-history.json');
const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const REDACTED = '[REDACTED]';

// Headers whose values must never be persisted to disk
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

// Body field names (case-insensitive) that should be redacted
const SENSITIVE_BODY_FIELDS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'api_secret',
  'client_secret',
  'private_key',
  'credentials',
  'ssn',
  'credit_card',
  'card_number',
]);

/**
 * Redact sensitive values from an object's keys (case-insensitive match).
 */
function redactObject(obj, sensitiveKeys) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      result[key] = REDACTED;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Redact sensitive data from a history entry before persisting.
 * Returns a new object — never mutates the original.
 */
function redactEntry(entry) {
  const redacted = { ...entry };

  // Redact headers
  if (redacted.headers) {
    redacted.headers = redactObject(redacted.headers, SENSITIVE_HEADERS);
  }

  // Redact sensitive fields inside JSON bodies
  if (redacted.body && typeof redacted.body === 'string') {
    try {
      const parsed = JSON.parse(redacted.body);
      if (parsed && typeof parsed === 'object') {
        redacted.body = JSON.stringify(redactObject(parsed, SENSITIVE_BODY_FIELDS));
      }
    } catch {
      // Not JSON — leave as-is
    }
  }

  return redacted;
}

/**
 * Remove entries older than MAX_HISTORY_AGE_MS.
 */
function pruneExpired(history) {
  const cutoff = Date.now() - MAX_HISTORY_AGE_MS;
  return history.filter((entry) => entry.timestamp >= cutoff);
}

// Serialize all write operations to prevent race conditions
let writeQueue = Promise.resolve();

/**
 * Ensure the .fere directory exists
 */
function ensureConfigDir() {
  const configDir = path.join(os.homedir(), '.fere');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Read and parse the history file, returning an array.
 * Returns [] on missing/corrupted file.
 */
function readHistoryFile() {
  if (!fs.existsSync(HISTORY_FILE_PATH)) return [];
  try {
    const raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Write history array to disk atomically using rename.
 */
function writeHistoryFile(history) {
  const tmp = HISTORY_FILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf-8');
  fs.renameSync(tmp, HISTORY_FILE_PATH);
}

/**
 * Load request history from disk
 * @returns {{ success: boolean, history?: Array, error?: string }}
 */
function loadHistory() {
  try {
    const history = pruneExpired(readHistoryFile());
    return { success: true, history };
  } catch (error) {
    console.error('Error loading request history:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Save a new history entry to disk.
 * Writes are serialized through a queue so concurrent calls don't race.
 * @param {Object} entry - The history entry to save
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function saveHistoryEntry(entry) {
  writeQueue = writeQueue.then(() => {
    ensureConfigDir();

    let history = readHistoryFile();

    history.unshift(redactEntry(entry));

    if (history.length > MAX_HISTORY_ENTRIES) {
      history = history.slice(0, MAX_HISTORY_ENTRIES);
    }

    writeHistoryFile(history);
  });

  return writeQueue.then(() => ({ success: true })).catch((error) => {
    console.error('Error saving history entry:', error);
    return { success: false, error: error.message };
  });
}

/**
 * Clear all request history
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function clearHistory() {
  writeQueue = writeQueue.then(() => {
    if (fs.existsSync(HISTORY_FILE_PATH)) {
      writeHistoryFile([]);
    }
  });

  return writeQueue.then(() => ({ success: true })).catch((error) => {
    console.error('Error clearing history:', error);
    return { success: false, error: error.message };
  });
}

module.exports = {
  loadHistory,
  saveHistoryEntry,
  clearHistory,
};
