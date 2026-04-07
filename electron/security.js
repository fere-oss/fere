/**
 * Security utilities for Electron app hardening.
 * Contains URL validation, SSRF protection, and security handlers.
 */

const { shell, session } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS_FILE_PATH = path.join(os.homedir(), ".fere", "settings.json");

// ============================================
// URL Validation
// ============================================

// Allowed protocols for external URL opening
const ALLOWED_EXTERNAL_PROTOCOLS = ["http:", "https:"];

// Dangerous protocols that should never be allowed
const DANGEROUS_PROTOCOLS = [
  "file:",
  "javascript:",
  "data:",
  "vbscript:",
  "about:",
];

/**
 * Validates a URL for safe external opening.
 * Returns { valid: true, url: URL } or { valid: false, reason: string }
 */
function validateExternalUrl(urlString) {
  if (!urlString || typeof urlString !== "string") {
    return { valid: false, reason: "URL must be a non-empty string" };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (e) {
    return { valid: false, reason: "Invalid URL format" };
  }

  const protocol = parsed.protocol.toLowerCase();

  // Block dangerous protocols explicitly
  if (DANGEROUS_PROTOCOLS.includes(protocol)) {
    return { valid: false, reason: `Protocol '${protocol}' is not allowed` };
  }

  // Only allow http/https
  if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(protocol)) {
    return {
      valid: false,
      reason: `Protocol '${protocol}' is not allowed for external URLs`,
    };
  }

  return { valid: true, url: parsed };
}

// ============================================
// SSRF Protection
// ============================================

// Private/reserved IP ranges (RFC 1918, RFC 5737, RFC 6598, loopback, link-local)
const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback 127.0.0.0/8
  /^10\./, // Private 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private 172.16.0.0/12
  /^192\.168\./, // Private 192.168.0.0/16
  /^169\.254\./, // Link-local 169.254.0.0/16
  /^0\./, // Current network 0.0.0.0/8
  /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\./, // Carrier-grade NAT 100.64.0.0/10
  /^192\.0\.0\./, // IETF Protocol Assignments 192.0.0.0/24
  /^192\.0\.2\./, // TEST-NET-1 192.0.2.0/24
  /^198\.51\.100\./, // TEST-NET-2 198.51.100.0/24
  /^203\.0\.113\./, // TEST-NET-3 203.0.113.0/24
  /^224\./, // Multicast 224.0.0.0/4
  /^240\./, // Reserved 240.0.0.0/4
];

// Hostnames that resolve to localhost/private
const BLOCKED_HOSTNAMES = [
  "localhost",
  "localhost.localdomain",
  "local",
  "ip6-localhost",
  "ip6-loopback",
];

// Maximum response size (10MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

/**
 * Checks if a hostname or IP is a private/internal address.
 */
function isPrivateHost(hostname) {
  if (!hostname || typeof hostname !== "string") {
    return true; // Treat invalid as blocked
  }

  const lower = hostname.toLowerCase();

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(lower)) {
    return true;
  }

  // Check if it's an IPv6 loopback
  if (lower === "::1" || lower === "[::1]") {
    return true;
  }

  // Check private IP patterns
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a URL for HTTP requests (SSRF protection).
 * Returns { valid: true, url: URL } or { valid: false, reason: string }
 */
function validateHttpRequestUrl(urlString, allowPrivate = false) {
  if (!urlString || typeof urlString !== "string") {
    return { valid: false, reason: "URL must be a non-empty string" };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (e) {
    return { valid: false, reason: "Invalid URL format" };
  }

  const protocol = parsed.protocol.toLowerCase();

  // Only http/https allowed
  if (protocol !== "http:" && protocol !== "https:") {
    return { valid: false, reason: `Protocol '${protocol}' is not allowed` };
  }

  // SSRF check: block private/internal addresses unless explicitly allowed
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    return {
      valid: false,
      reason: "Requests to private/internal addresses are blocked",
    };
  }

  return { valid: true, url: parsed };
}

// ============================================
// Navigation & Window Security
// ============================================

/**
 * Sets up navigation blocking on a webContents.
 * Prevents navigation to non-app origins.
 */
function setupNavigationBlocking(webContents, allowedOrigins) {
  webContents.on("will-navigate", (event, navigationUrl) => {
    let parsed;
    try {
      parsed = new URL(navigationUrl);
    } catch (e) {
      event.preventDefault();
      console.warn(
        "[Security] Blocked navigation to invalid URL:",
        navigationUrl,
      );
      return;
    }

    const origin = parsed.origin;
    // file:// URLs have origin "null" (the string), so check protocol as fallback
    const isAllowed =
      allowedOrigins.includes(origin) ||
      (parsed.protocol === "file:" && allowedOrigins.includes("file://"));
    if (!isAllowed) {
      event.preventDefault();
      console.warn(
        "[Security] Blocked navigation to disallowed origin:",
        origin,
      );
    }
  });
}

/**
 * Sets up window open handler.
 * Denies all new windows by default, opens http/https URLs in external browser.
 */
function setupWindowOpenHandler(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    const validation = validateExternalUrl(url);
    if (validation.valid) {
      // Open in external browser instead of new Electron window
      shell.openExternal(url).catch((err) => {
        console.error("[Security] Failed to open external URL:", err);
      });
    } else {
      console.warn(
        "[Security] Blocked window open for:",
        url,
        "-",
        validation.reason,
      );
    }

    // Always deny creating new Electron windows
    return { action: "deny" };
  });
}

// ============================================
// Permission Handlers
// ============================================

/**
 * Sets up default-deny permission handlers.
 * Blocks all permission requests by default.
 */
function setupPermissionHandlers() {
  const ses = session.defaultSession;

  // Block all permission requests by default
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    console.warn("[Security] Denied permission request:", permission);
    callback(false);
  });

  // Also handle permission checks (for APIs that check without requesting)
  ses.setPermissionCheckHandler((webContents, permission) => {
    // Allow clipboard-read and clipboard-write for app functionality
    if (
      permission === "clipboard-read" ||
      permission === "clipboard-sanitized-write"
    ) {
      return true;
    }
    return false;
  });
}

// ============================================
// Content Security Policy
// ============================================

/**
 * Sets up Content Security Policy via session response headers.
 * Uses different policies for development vs production.
 */
function setupCSP(isDev) {
  const ses = session.defaultSession;

  // Development CSP: Allow React HMR (WebSockets, eval for source maps)
  const devCSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'", // unsafe-eval + unsafe-inline needed for React dev server
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://img.logo.dev https://*.logo.dev https://*.googleusercontent.com https://avatars.githubusercontent.com",
    "connect-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* ws://localhost:* wss://localhost:*",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // Production CSP: Strict, no eval or WebSockets needed
  const prodCSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://img.logo.dev https://*.logo.dev https://*.googleusercontent.com https://avatars.githubusercontent.com",
    "connect-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const csp = isDev ? devCSP : prodCSP;

  // Set CSP header on document responses only (not subresources like images)
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });
}

// ============================================
// Network Policy
// ============================================

// In-memory cache for network policy — avoids blocking file I/O on every request
let _cachedNetworkPolicy = null;

/**
 * Read the current network policy from settings.json.
 * Returns "local" (allow private networks) or "public" (block them).
 * Default: "local" — this is a local dev tool.
 * Uses in-memory cache after first read; cache is invalidated by setNetworkPolicy().
 */
function getNetworkPolicy() {
  if (_cachedNetworkPolicy !== null) return _cachedNetworkPolicy;

  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const raw = fs.readFileSync(SETTINGS_FILE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      _cachedNetworkPolicy =
        parsed.networkPolicy === "public" ? "public" : "local";
      return _cachedNetworkPolicy;
    }
  } catch {
    // Corrupt/missing — fall through to default
  }
  _cachedNetworkPolicy = "local";
  return "local";
}

/**
 * Persist the network policy to settings.json.
 * @param {"local"|"public"} policy
 */
function setNetworkPolicy(policy) {
  if (policy !== "local" && policy !== "public") {
    return { success: false, error: "Policy must be 'local' or 'public'" };
  }

  const configDir = path.join(os.homedir(), ".fere");
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let existing = {};
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      existing = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, "utf-8"));
    }
  } catch {
    // start fresh
  }
  existing.networkPolicy = policy;
  const tmp = SETTINGS_FILE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf-8");
  fs.renameSync(tmp, SETTINGS_FILE_PATH);

  // Update in-memory cache immediately
  _cachedNetworkPolicy = policy;

  return { success: true };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // URL validation
  validateExternalUrl,
  validateHttpRequestUrl,
  isPrivateHost,
  ALLOWED_EXTERNAL_PROTOCOLS,
  DANGEROUS_PROTOCOLS,
  MAX_RESPONSE_SIZE,

  // Network policy
  getNetworkPolicy,
  setNetworkPolicy,

  // Security setup
  setupNavigationBlocking,
  setupWindowOpenHandler,
  setupPermissionHandlers,
  setupCSP,
};
