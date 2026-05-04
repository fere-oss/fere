/**
 * Shared constants for the Electron main process.
 * Centralises magic numbers so they are easy to find and adjust.
 */

/** Port the one-shot OAuth callback HTTP server listens on. */
const AUTH_CALLBACK_PORT = 38383;

/** How often (ms) to silently refresh the Supabase access token in the background. */
const AUTH_TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum number of free Sentinel AI scans per user per day. */
const SENTINEL_DAILY_LIMIT = 5;

module.exports = {
  AUTH_CALLBACK_PORT,
  AUTH_TOKEN_REFRESH_INTERVAL_MS,
  SENTINEL_DAILY_LIMIT,
};
