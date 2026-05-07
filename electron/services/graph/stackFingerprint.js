"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Env file names to scan (mirrors externalApiScanner.js)
const ENV_FILE_NAMES = [".env", ".env.local", ".env.development", ".env.production", ".env.test"];

/**
 * Collect .env* file paths that exist under a given directory.
 * Only looks at the root of the directory, not subdirectories.
 * @param {string} dirPath
 * @returns {string[]}
 */
function findEnvFiles(dirPath) {
  if (!dirPath) return [];
  const files = [];
  for (const name of ENV_FILE_NAMES) {
    const fullPath = path.join(dirPath, name);
    try {
      if (fs.existsSync(fullPath)) {
        files.push(fullPath);
      }
    } catch {
      // skip unreadable paths
    }
  }
  return files;
}

/**
 * Extract env variable KEY names from a list of file paths.
 * Only captures names matching /^[A-Z_][A-Z0-9_]*=/ (POSIX convention).
 * Values are never collected.
 * @param {string[]} filePaths
 * @returns {string[]} sorted, deduplicated key names
 */
function extractEnvKeys(filePaths) {
  const keys = new Set();
  const KEY_REGEX = /^([A-Z_][A-Z0-9_]*)=/m;

  for (const filePath of filePaths) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // skip comments and blank lines fast
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = KEY_REGEX.exec(trimmed);
      if (match) {
        keys.add(match[1]);
      }
    }
  }
  return Array.from(keys).sort();
}

/**
 * Collect env keys from all unique project paths found in the snapshot graph nodes.
 * @param {object} snapshot - SystemSnapshot
 * @returns {string[]}
 */
function collectEnvKeysFromSnapshot(snapshot) {
  const nodes = snapshot?.graph?.nodes ?? [];
  const projectPaths = new Set();

  for (const node of nodes) {
    if (node.projectPath) projectPaths.add(node.projectPath);
    if (node.repoPath) projectPaths.add(node.repoPath);
  }

  const allFiles = [];
  for (const dir of projectPaths) {
    allFiles.push(...findEnvFiles(dir));
  }

  return extractEnvKeys(allFiles);
}

/**
 * Build a sanitized stack fingerprint from a live system snapshot.
 *
 * @param {object} snapshot - SystemSnapshot from snapshotScheduler
 * @param {string|null} projectPath - optional single project root for env scan
 * @param {string} label - human-readable label for this fingerprint
 * @returns {object} StackFingerprint
 */
async function buildFingerprint(snapshot, projectPath, label) {
  // 1. Extract services from graph nodes
  const rawNodes = snapshot?.graph?.nodes ?? [];
  const services = rawNodes
    .filter((node) => node.type !== "external" && !node.isGhost)
    .map((node) => ({
      name: node.name,
      type: node.type,
      ports: (node.ports ?? []).map((p) => p.port).sort((a, b) => a - b),
      health: node.healthStatus ?? "unknown",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 2. Extract containers
  const rawContainers = snapshot?.docker?.containers ?? [];
  const containers = rawContainers
    .map((c) => {
      const fullImage = c.image ?? "";
      // strip registry prefix, keep repo/name portion
      const imageName = fullImage.split(":")[0].split("/").pop() ?? fullImage;
      const imageTag = fullImage.includes(":") ? fullImage.split(":").slice(1).join(":") : "latest";
      const ports = (c.ports ?? [])
        .map((p) => p.hostPort || p.containerPort)
        .filter(Boolean)
        .sort((a, b) => a - b);
      return {
        name: c.name ?? c.id ?? "unknown",
        image: imageName,
        imageTag,
        state: c.state ?? "unknown",
        ports,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // 3. Collect env keys
  let envKeys = [];
  if (projectPath) {
    envKeys = extractEnvKeys(findEnvFiles(projectPath));
  } else {
    envKeys = collectEnvKeysFromSnapshot(snapshot);
  }

  // 4. Build fingerprint object
  const fingerprint = {
    version: 1,
    generatedAt: Date.now(),
    label: label || "My Stack",
    services,
    containers,
    envKeys,
  };

  // 5. Compute checksum over content fields only
  const checksum = crypto
    .createHash("sha256")
    .update(JSON.stringify({ services, containers, envKeys }))
    .digest("hex")
    .slice(0, 8);

  return { ...fingerprint, checksum };
}

module.exports = { buildFingerprint };
