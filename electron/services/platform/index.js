/**
 * Platform abstraction layer — routes to the correct OS implementation.
 *
 * All OS-specific operations (process listing, port monitoring, CWD lookup,
 * Docker paths, shell commands) are accessed through this module.
 *
 * Consumers: const { fetchListeningPorts } = require('./platform');
 */

const platform = process.platform;

let impl;
switch (platform) {
  case "darwin":
    impl = require("./darwin");
    break;
  case "win32":
    impl = require("./win32");
    break;
  default:
    throw new Error(
      `Unsupported platform: ${platform}. ` +
        `Fere currently supports: darwin (macOS). ` +
        `See electron/services/platform/ to add support for your OS.`,
    );
}

module.exports = impl;
