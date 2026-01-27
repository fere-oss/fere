const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_FILE_PATH = path.join(os.homedir(), '.fere', 'request-history.json');
const MAX_HISTORY_ENTRIES = 100;

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
 * Load request history from disk
 * @returns {{ success: boolean, history?: Array, error?: string }}
 */
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE_PATH)) {
      return { success: true, history: [] };
    }
    const raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { success: true, history: [] };
    }
    return { success: true, history: parsed };
  } catch (error) {
    console.error('Error loading request history:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Save a new history entry to disk
 * @param {Object} entry - The history entry to save
 * @returns {{ success: boolean, error?: string }}
 */
function saveHistoryEntry(entry) {
  try {
    ensureConfigDir();

    let history = [];
    if (fs.existsSync(HISTORY_FILE_PATH)) {
      try {
        const raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          history = parsed;
        }
      } catch (e) {
        // Start fresh if file is corrupted
        history = [];
      }
    }

    // Add new entry at the beginning (most recent first)
    history.unshift(entry);

    // Trim to max entries
    if (history.length > MAX_HISTORY_ENTRIES) {
      history = history.slice(0, MAX_HISTORY_ENTRIES);
    }

    fs.writeFileSync(HISTORY_FILE_PATH, JSON.stringify(history, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Error saving history entry:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Clear all request history
 * @returns {{ success: boolean, error?: string }}
 */
function clearHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE_PATH)) {
      fs.writeFileSync(HISTORY_FILE_PATH, '[]', 'utf-8');
    }
    return { success: true };
  } catch (error) {
    console.error('Error clearing history:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  loadHistory,
  saveHistoryEntry,
  clearHistory,
};
