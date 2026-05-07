/**
 * Shared Docker binary resolution — used by dockerMonitor, containerLogs,
 * databaseQuery, and debugAgent.
 *
 * Previously each file had its own copy of DOCKER_BIN_CANDIDATES,
 * getDockerBinaries(), and resolveDockerBinary(). This module centralizes them.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");

const execFileAsync = promisify(execFile);
const { DOCKER_BIN_CANDIDATES } = require("./index");

const DOCKER_EXEC_TIMEOUT_MS = 15000;
let resolvedDockerBin = null;

/**
 * Filter candidates to those that exist on disk (for absolute paths)
 * or are bare commands (resolved via PATH).
 */
function getDockerBinaries() {
  const bins = [];
  for (const bin of DOCKER_BIN_CANDIDATES) {
    // Absolute paths: check they exist. Bare commands (no /): keep as-is.
    if ((bin.includes("/") || bin.includes("\\")) && !fs.existsSync(bin)) continue;
    bins.push(bin);
  }
  return bins.length > 0 ? bins : ["docker"];
}

/**
 * Resolve the Docker binary by probing candidates.
 * Caches the result for subsequent calls.
 * @param {object} [options]
 * @param {number} [options.timeout] - Probe timeout in ms (default: DOCKER_EXEC_TIMEOUT_MS)
 * @returns {Promise<string|null>} Path to the Docker binary, or null
 */
async function resolveDockerBinary(options = {}) {
  if (resolvedDockerBin) return resolvedDockerBin;

  const timeout = options.timeout || DOCKER_EXEC_TIMEOUT_MS;
  const candidates = getDockerBinaries();

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["version", "--format", "{{.Client.Version}}"], {
        timeout,
        maxBuffer: 1024 * 1024,
      });
      resolvedDockerBin = candidate;
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  resolvedDockerBin = null;
  return null;
}

/**
 * Run a Docker CLI command. Tries the resolved binary first, then falls back
 * to all candidates.
 * @param {string[]} args - Docker CLI arguments
 * @param {object} [options]
 * @param {boolean} [options.allowFailure] - If true, throws on failure instead of generic error
 * @param {number} [options.timeout] - Execution timeout in ms
 * @returns {Promise<string>} stdout
 */
async function runDocker(args, options = {}) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const allowFailure = !!options.allowFailure;
  const timeout = options.timeout || DOCKER_EXEC_TIMEOUT_MS;

  const preferred = await resolveDockerBinary({ timeout });
  const candidates = preferred ? [preferred] : getDockerBinaries();

  let lastError = null;
  for (const bin of candidates) {
    try {
      const result = await execFileAsync(bin, normalizedArgs, {
        timeout,
        maxBuffer: 1024 * 1024,
      });
      resolvedDockerBin = bin;
      return result.stdout || "";
    } catch (error) {
      lastError = error;
      const isMissingBinary =
        error?.code === "ENOENT" || /not found/i.test(String(error?.message || ""));
      if (isMissingBinary) continue;
      throw error;
    }
  }

  if (allowFailure && lastError) {
    throw lastError;
  }
  throw new Error("Docker CLI not found. Tried: " + candidates.join(", "));
}

/**
 * Get the resolved binary path, throwing if unavailable.
 */
async function getDockerBinaryOrThrow() {
  const dockerBin = await resolveDockerBinary();
  if (!dockerBin) {
    throw new Error("Docker CLI not found. Tried: " + getDockerBinaries().join(", "));
  }
  return dockerBin;
}

/**
 * Clear the cached Docker binary (e.g. after Docker Desktop restart).
 */
function clearDockerBinCache() {
  resolvedDockerBin = null;
}

module.exports = {
  DOCKER_EXEC_TIMEOUT_MS,
  getDockerBinaries,
  resolveDockerBinary,
  runDocker,
  getDockerBinaryOrThrow,
  clearDockerBinCache,
};
