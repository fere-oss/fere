import posthog from "posthog-js";

const POSTHOG_API_KEY = process.env.REACT_APP_POSTHOG_API_KEY || "";
const POSTHOG_HOST = "https://us.i.posthog.com";

let initialized = false;

/**
 * Generate a stable anonymous ID from available browser info.
 * Matches the main-process hashing approach (hostname + username),
 * but in the renderer we use a localStorage-persisted random ID
 * that gets linked to the main-process ID via PostHog alias.
 */
function getOrCreateDistinctId(): string {
  const KEY = "fere.analyticsId";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
  } catch {
    // localStorage unavailable
  }

  // Generate a random ID and persist it
  const id =
    "fere_" +
    Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  try {
    localStorage.setItem(KEY, id);
  } catch {
    // localStorage unavailable
  }
  return id;
}

export function initAnalytics(): void {
  if (initialized) return;
  if (!POSTHOG_API_KEY) return; // no-op when key is not configured
  initialized = true;

  posthog.init(POSTHOG_API_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    persistence: "localStorage",
    bootstrap: {
      distinctID: getOrCreateDistinctId(),
    },
  });
}

export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

export function identifyWithMainProcess(mainProcessId: string): void {
  if (!initialized) return;
  // Link renderer ID to main process ID so both sides merge into one user
  posthog.alias(mainProcessId);
}
