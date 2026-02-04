/**
 * Tests for security validation helpers.
 * Run with: node --test electron/security.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// Mock Electron modules before requiring security.js
const mockShell = { openExternal: async () => {} };
const mockSession = {
  defaultSession: {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  },
};

// Override require for electron
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "electron") {
    return { shell: mockShell, session: mockSession };
  }
  return originalRequire.apply(this, arguments);
};

// Now require security module
const {
  validateExternalUrl,
  validateHttpRequestUrl,
  isPrivateHost,
} = require("./security");

// Restore original require after importing
Module.prototype.require = originalRequire;

// ============================================
// validateExternalUrl tests
// ============================================

test("validateExternalUrl allows http URLs", () => {
  const result = validateExternalUrl("http://example.com");
  assert.equal(result.valid, true);
  assert.equal(result.url.hostname, "example.com");
});

test("validateExternalUrl allows https URLs", () => {
  const result = validateExternalUrl("https://example.com/path?query=1");
  assert.equal(result.valid, true);
  assert.equal(result.url.protocol, "https:");
});

test("validateExternalUrl blocks file: URLs", () => {
  const result = validateExternalUrl("file:///etc/passwd");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("not allowed"));
});

test("validateExternalUrl blocks javascript: URLs", () => {
  const result = validateExternalUrl("javascript:alert(1)");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("not allowed"));
});

test("validateExternalUrl blocks data: URLs", () => {
  const result = validateExternalUrl("data:text/html,<script>alert(1)</script>");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("not allowed"));
});

test("validateExternalUrl blocks vbscript: URLs", () => {
  const result = validateExternalUrl("vbscript:msgbox(1)");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("not allowed"));
});

test("validateExternalUrl rejects empty input", () => {
  const result = validateExternalUrl("");
  assert.equal(result.valid, false);
});

test("validateExternalUrl rejects non-string input", () => {
  const result = validateExternalUrl(null);
  assert.equal(result.valid, false);
});

test("validateExternalUrl rejects malformed URLs", () => {
  const result = validateExternalUrl("not a url");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("Invalid URL"));
});

// ============================================
// isPrivateHost tests
// ============================================

test("isPrivateHost detects localhost", () => {
  assert.equal(isPrivateHost("localhost"), true);
});

test("isPrivateHost detects 127.0.0.1", () => {
  assert.equal(isPrivateHost("127.0.0.1"), true);
});

test("isPrivateHost detects 10.x.x.x", () => {
  assert.equal(isPrivateHost("10.0.0.1"), true);
  assert.equal(isPrivateHost("10.255.255.255"), true);
});

test("isPrivateHost detects 172.16-31.x.x", () => {
  assert.equal(isPrivateHost("172.16.0.1"), true);
  assert.equal(isPrivateHost("172.31.255.255"), true);
  assert.equal(isPrivateHost("172.15.0.1"), false);
  assert.equal(isPrivateHost("172.32.0.1"), false);
});

test("isPrivateHost detects 192.168.x.x", () => {
  assert.equal(isPrivateHost("192.168.1.1"), true);
  assert.equal(isPrivateHost("192.167.1.1"), false);
});

test("isPrivateHost detects IPv6 loopback", () => {
  assert.equal(isPrivateHost("::1"), true);
  assert.equal(isPrivateHost("[::1]"), true);
});

test("isPrivateHost allows public IPs", () => {
  assert.equal(isPrivateHost("8.8.8.8"), false);
  assert.equal(isPrivateHost("1.1.1.1"), false);
  assert.equal(isPrivateHost("93.184.216.34"), false);
});

test("isPrivateHost allows public domains", () => {
  assert.equal(isPrivateHost("example.com"), false);
  assert.equal(isPrivateHost("google.com"), false);
});

// ============================================
// validateHttpRequestUrl tests
// ============================================

test("validateHttpRequestUrl allows http URLs", () => {
  const result = validateHttpRequestUrl("http://example.com");
  assert.equal(result.valid, true);
});

test("validateHttpRequestUrl allows https URLs", () => {
  const result = validateHttpRequestUrl("https://api.example.com/v1");
  assert.equal(result.valid, true);
});

test("validateHttpRequestUrl blocks localhost by default", () => {
  const result = validateHttpRequestUrl("http://localhost:3000");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("private"));
});

test("validateHttpRequestUrl blocks 127.0.0.1 by default", () => {
  const result = validateHttpRequestUrl("http://127.0.0.1:8080");
  assert.equal(result.valid, false);
});

test("validateHttpRequestUrl allows localhost when allowPrivate=true", () => {
  const result = validateHttpRequestUrl("http://localhost:3000", true);
  assert.equal(result.valid, true);
});

test("validateHttpRequestUrl allows 127.0.0.1 when allowPrivate=true", () => {
  const result = validateHttpRequestUrl("http://127.0.0.1:8080", true);
  assert.equal(result.valid, true);
});

test("validateHttpRequestUrl blocks file: URLs", () => {
  const result = validateHttpRequestUrl("file:///etc/passwd");
  assert.equal(result.valid, false);
});

test("validateHttpRequestUrl blocks ftp: URLs", () => {
  const result = validateHttpRequestUrl("ftp://ftp.example.com");
  assert.equal(result.valid, false);
});

test("validateHttpRequestUrl blocks private IPs by default", () => {
  const result = validateHttpRequestUrl("http://10.0.0.1:80");
  assert.equal(result.valid, false);

  const result2 = validateHttpRequestUrl("http://192.168.1.1");
  assert.equal(result2.valid, false);
});

test("validateHttpRequestUrl rejects invalid input", () => {
  assert.equal(validateHttpRequestUrl("").valid, false);
  assert.equal(validateHttpRequestUrl(null).valid, false);
  assert.equal(validateHttpRequestUrl("not-a-url").valid, false);
});
