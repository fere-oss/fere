const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_FILE_PATH = path.join(os.homedir(), '.fere', 'request-history.json');
const MAX_HISTORY_ENTRIES = 100;

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
    return { success: true, history: readHistoryFile() };
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
    try {
      ensureConfigDir();

      let history = readHistoryFile();

      history.unshift(entry);

      if (history.length > MAX_HISTORY_ENTRIES) {
        history = history.slice(0, MAX_HISTORY_ENTRIES);
      }

      writeHistoryFile(history);
    } catch (error) {
      console.error('Error saving history entry:', error);
    }
  });

  return writeQueue.then(() => ({ success: true })).catch((error) => ({
    success: false,
    error: error.message,
  }));
}

/**
 * Clear all request history
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function clearHistory() {
  writeQueue = writeQueue.then(() => {
    try {
      if (fs.existsSync(HISTORY_FILE_PATH)) {
        writeHistoryFile([]);
      }
    } catch (error) {
      console.error('Error clearing history:', error);
    }
  });

  return writeQueue.then(() => ({ success: true })).catch((error) => ({
    success: false,
    error: error.message,
  }));
}

module.exports = {
  loadHistory,
  saveHistoryEntry,
  clearHistory,
};
