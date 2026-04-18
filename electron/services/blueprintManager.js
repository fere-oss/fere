'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BLUEPRINTS_DIR = path.join(os.homedir(), '.fere', 'blueprints');

function ensureBlueprintsDir() {
  fs.mkdirSync(BLUEPRINTS_DIR, { recursive: true });
}

function repoHash(repoPath) {
  return crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 10);
}

function blueprintPath(hash) {
  return path.join(BLUEPRINTS_DIR, `${hash}.json`);
}

function extractEnvKeys(projectPath) {
  const envFileNames = ['.env', '.env.local', '.env.development', '.env.test', '.env.production'];
  const keys = new Set();
  for (const name of envFileNames) {
    const filePath = path.join(projectPath, name);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = content.matchAll(/^([A-Z_][A-Z0-9_]*)=/mg);
      for (const match of matches) keys.add(match[1]);
    } catch (_) { /* file doesn't exist, skip */ }
  }
  return Array.from(keys).sort();
}

async function saveBlueprint(snapshot, projectPath, label) {
  ensureBlueprintsDir();

  const hash = repoHash(projectPath);

  // Extract services from graph nodes matching this project
  const services = (snapshot.graph?.nodes ?? [])
    .filter(n => {
      if (n.isGhost) return false;
      if (n.type === 'external') return false;
      // If projectPath is provided, filter by it; otherwise include all non-external nodes
      if (projectPath) {
        const nodePath = n.projectPath || n.repoPath;
        if (!nodePath) return false;
        return nodePath === projectPath || nodePath.startsWith(projectPath) || projectPath.startsWith(nodePath);
      }
      return true;
    })
    .map(n => ({
      name: n.name,
      type: n.type,
      ports: (n.ports ?? []).map(p => p.port),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Extract containers related to this project
  const containers = (snapshot.docker?.containers ?? [])
    .filter(c => {
      const composeDir = c.labels?.['com.docker.compose.project.working_dir'];
      if (composeDir) {
        if (!projectPath) return true; // System-wide: include all with compose labels
        return (
          composeDir === projectPath ||
          composeDir.startsWith(projectPath) ||
          projectPath.startsWith(composeDir)
        );
      }
      // If no compose info, include all running containers when saving
      return c.state === 'running';
    })
    .map(c => {
      const imageParts = (c.image || '').split(':');
      const imageName = imageParts[0].split('/').pop();
      const imageTag = imageParts[1] || 'latest';
      return {
        name: c.name,
        image: imageName,
        imageTag,
        ports: (c.ports ?? []).map(p => p.hostPort || p.containerPort).filter(Boolean),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const requiredEnvKeys = projectPath ? extractEnvKeys(projectPath) : [];

  // Compute dependency order: topological sort of edges between these service nodes
  const serviceIds = new Set(
    (snapshot.graph?.nodes ?? [])
      .filter(n => {
        if (n.isGhost || n.type === 'external') return false;
        if (projectPath) {
          const nodePath = n.projectPath || n.repoPath;
          if (!nodePath) return false;
          return nodePath === projectPath || nodePath.startsWith(projectPath) || projectPath.startsWith(nodePath);
        }
        return true;
      })
      .map(n => n.id)
  );

  const edges = (snapshot.graph?.edges ?? [])
    .filter(e => serviceIds.has(e.source) && serviceIds.has(e.target));

  // Build name lookup map
  const nodeNames = new Map();
  for (const node of snapshot.graph?.nodes ?? []) {
    if (serviceIds.has(node.id)) {
      nodeNames.set(node.id, node.name);
    }
  }

  // Simple topological sort by in-degree (edges point from dependency to dependent)
  const inDegree = new Map();
  for (const id of serviceIds) {
    inDegree.set(id, 0);
  }
  for (const edge of edges) {
    inDegree.set(edge.source, (inDegree.get(edge.source) || 0) + 1);
  }
  const dependencyOrder = Array.from(inDegree.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => nodeNames.get(id))
    .filter(Boolean);

  const blueprint = {
    version: 1,
    savedAt: Date.now(),
    repoPath: projectPath || '__system__',
    repoHash: hash,
    label: label || (projectPath ? path.basename(projectPath) : 'System'),
    services,
    containers,
    requiredEnvKeys,
    dependencyOrder,
  };

  // Atomic write: write to tmp then rename
  const filePath = blueprintPath(hash);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(blueprint, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);

  return { success: true, repoHash: hash };
}

function listBlueprints() {
  ensureBlueprintsDir();
  try {
    return fs.readdirSync(BLUEPRINTS_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(BLUEPRINTS_DIR, f), 'utf8'));
          return {
            repoHash: content.repoHash,
            repoPath: content.repoPath,
            label: content.label,
            savedAt: content.savedAt,
            serviceCount: content.services?.length ?? 0,
            containerCount: content.containers?.length ?? 0,
          };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch (_) { return []; }
}

function loadBlueprint(hash) {
  const filePath = blueprintPath(hash);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deleteBlueprint(hash) {
  const filePath = blueprintPath(hash);
  fs.unlinkSync(filePath);
}

function checkBlueprint(hash, snapshot) {
  const blueprint = loadBlueprint(hash);
  const projectPath = blueprint.repoPath === '__system__' ? null : blueprint.repoPath;

  // Build name lookup for current graph nodes
  const currentNodes = new Map();
  for (const node of snapshot.graph?.nodes ?? []) {
    currentNodes.set(node.name.toLowerCase(), node);
  }

  const serviceResults = blueprint.services.map(s => {
    const current = currentNodes.get(s.name.toLowerCase());
    if (!current) return { name: s.name, status: 'missing', detail: 'Not detected in current environment' };
    if (current.isGhost || current.healthStatus === 'red') {
      return { name: s.name, status: 'not-running', actual: 'stopped/crashed', detail: 'Service exists but is not running' };
    }
    const currentPorts = (current.ports ?? []).map(p => p.port).sort().join(',');
    const expectedPorts = (s.ports ?? []).sort().join(',');
    if (expectedPorts && currentPorts !== expectedPorts) {
      return { name: s.name, status: 'wrong-port', expected: `port ${expectedPorts}`, actual: `port ${currentPorts}`, detail: `Expected port ${expectedPorts}, running on ${currentPorts}` };
    }
    return { name: s.name, status: 'ok' };
  });

  // Build container lookup
  const currentContainers = new Map();
  for (const c of snapshot.docker?.containers ?? []) {
    currentContainers.set(c.name.toLowerCase(), c);
  }

  const containerResults = blueprint.containers.map(c => {
    const current = currentContainers.get(c.name.toLowerCase());
    if (!current) return { name: c.name, status: 'missing', detail: 'Container not found' };
    if (current.state !== 'running') {
      return { name: c.name, status: 'not-running', actual: current.state, detail: `Container is ${current.state}` };
    }
    // Check image tag
    const currentTag = (current.image || '').split(':')[1] || 'latest';
    if (c.imageTag !== 'latest' && currentTag !== c.imageTag) {
      return { name: c.name, status: 'wrong-version', expected: `${c.image}:${c.imageTag}`, actual: `${c.image}:${currentTag}`, detail: `Expected ${c.imageTag}, running ${currentTag}` };
    }
    return { name: c.name, status: 'ok' };
  });

  // Check env keys
  const currentKeys = projectPath ? new Set(extractEnvKeys(projectPath)) : new Set();
  const envResults = blueprint.requiredEnvKeys.map(key => {
    if (currentKeys.has(key)) return { name: key, status: 'ok' };
    return { name: key, status: 'missing', detail: 'Not found in any .env file' };
  });

  const allItems = [...serviceResults, ...containerResults, ...envResults];
  const okCount = allItems.filter(i => i.status === 'ok').length;
  const missingCount = allItems.filter(i => i.status === 'missing').length;
  const wrongCount = allItems.filter(i => i.status === 'wrong-version' || i.status === 'wrong-port' || i.status === 'not-running').length;
  const completionPct = allItems.length > 0 ? Math.round((okCount / allItems.length) * 100) : 100;

  return {
    completionPct,
    services: serviceResults,
    containers: containerResults,
    envKeys: envResults,
    missingCount,
    wrongCount,
    okCount,
  };
}

module.exports = { saveBlueprint, listBlueprints, loadBlueprint, deleteBlueprint, checkBlueprint };
