const { PostHog } = require("posthog-node");
const os = require("os");
const crypto = require("crypto");

const POSTHOG_API_KEY = "phc_MhtttIQgm4pTxbn7pfAV8Bsn2M3q2KegvObHotkPodv";
const POSTHOG_HOST = "https://us.i.posthog.com";

let client = null;
let distinctId = null;

/**
 * Generate a stable anonymous ID from machine characteristics.
 * No PII is stored — just a hash for deduplication across sessions.
 */
function getDistinctId() {
  if (distinctId) return distinctId;
  const raw = os.hostname() + os.userInfo().username + os.platform() + os.arch();
  distinctId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return distinctId;
}

function init() {
  if (client) return;
  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    flushAt: 10,
    flushInterval: 30000,
  });

  // Identify once on init with platform properties
  client.identify({
    distinctId: getDistinctId(),
    properties: {
      platform: os.platform(),
      arch: os.arch(),
      os_version: os.release(),
      node_version: process.version,
    },
  });
}

function capture(event, properties = {}) {
  if (!client) return;
  client.capture({
    distinctId: getDistinctId(),
    event,
    properties,
  });
}

async function shutdown() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // Best-effort flush on quit
  }
  client = null;
}

module.exports = { init, capture, shutdown, getDistinctId };
