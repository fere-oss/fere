"use strict";

const fs = require("fs");
const path = require("path");

const BLUEPRINT_FILENAME = ".fere/blueprint.json";

function blueprintFilePath(projectPath) {
  return path.join(projectPath, BLUEPRINT_FILENAME);
}

function extractEnvKeys(projectPath) {
  const envFileNames = [".env", ".env.local", ".env.development", ".env.test", ".env.production"];
  const keys = new Set();
  for (const name of envFileNames) {
    const filePath = path.join(projectPath, name);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const matches = content.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm);
      for (const match of matches) keys.add(match[1]);
    } catch (_) {
      /* file doesn't exist, skip */
    }
  }
  return Array.from(keys).sort();
}

async function saveBlueprint(snapshot, projectPath, label) {
  if (!projectPath || projectPath === "__system__") {
    throw new Error("Blueprint requires a project path");
  }

  // Ensure .fere/ directory exists inside the repo
  const fereDir = path.join(projectPath, ".fere");
  fs.mkdirSync(fereDir, { recursive: true });

  // Extract services from graph nodes matching this project
  const services = (snapshot.graph?.nodes ?? [])
    .filter((n) => {
      if (n.isGhost) return false;
      if (n.type === "external") return false;
      const nodePath = n.projectPath || n.repoPath;
      if (!nodePath) return false;
      return (
        nodePath === projectPath ||
        nodePath.startsWith(projectPath) ||
        projectPath.startsWith(nodePath)
      );
    })
    .map((n) => ({
      name: n.name,
      type: n.type,
      ports: (n.ports ?? []).map((p) => p.port),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Extract containers related to this project
  const containers = (snapshot.docker?.containers ?? [])
    .filter((c) => {
      const composeDir = c.labels?.["com.docker.compose.project.working_dir"];
      if (composeDir) {
        return (
          composeDir === projectPath ||
          composeDir.startsWith(projectPath) ||
          projectPath.startsWith(composeDir)
        );
      }
      return c.state === "running";
    })
    .map((c) => {
      const imageParts = (c.image || "").split(":");
      const imageName = imageParts[0].split("/").pop();
      const imageTag = imageParts[1] || "latest";
      return {
        name: c.name,
        image: imageName,
        imageTag,
        ports: (c.ports ?? []).map((p) => p.hostPort || p.containerPort).filter(Boolean),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const requiredEnvKeys = extractEnvKeys(projectPath);

  // Topological sort of edges between project nodes for dependency order
  const serviceIds = new Set(
    (snapshot.graph?.nodes ?? [])
      .filter((n) => {
        if (n.isGhost || n.type === "external") return false;
        const nodePath = n.projectPath || n.repoPath;
        if (!nodePath) return false;
        return (
          nodePath === projectPath ||
          nodePath.startsWith(projectPath) ||
          projectPath.startsWith(nodePath)
        );
      })
      .map((n) => n.id),
  );

  const edges = (snapshot.graph?.edges ?? []).filter(
    (e) => serviceIds.has(e.source) && serviceIds.has(e.target),
  );

  const nodeNames = new Map();
  for (const node of snapshot.graph?.nodes ?? []) {
    if (serviceIds.has(node.id)) nodeNames.set(node.id, node.name);
  }

  const inDegree = new Map();
  for (const id of serviceIds) inDegree.set(id, 0);
  for (const edge of edges) inDegree.set(edge.source, (inDegree.get(edge.source) || 0) + 1);
  const dependencyOrder = Array.from(inDegree.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => nodeNames.get(id))
    .filter(Boolean);

  const blueprint = {
    version: 1,
    savedAt: Date.now(),
    repoPath: projectPath,
    label: label || path.basename(projectPath),
    services,
    containers,
    requiredEnvKeys,
    dependencyOrder,
  };

  // Atomic write: tmp then rename
  const filePath = blueprintFilePath(projectPath);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(blueprint, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);

  return { success: true };
}

function loadBlueprint(projectPath) {
  try {
    const content = fs.readFileSync(blueprintFilePath(projectPath), "utf8");
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function deleteBlueprint(projectPath) {
  fs.unlinkSync(blueprintFilePath(projectPath));
}

function checkBlueprint(projectPath, snapshot) {
  const blueprint = loadBlueprint(projectPath);
  if (!blueprint) throw new Error("No blueprint found for this project");

  const currentNodes = new Map();
  for (const node of snapshot.graph?.nodes ?? []) {
    currentNodes.set(node.name.toLowerCase(), node);
  }

  const serviceResults = blueprint.services.map((s) => {
    const current = currentNodes.get(s.name.toLowerCase());
    if (!current)
      return { name: s.name, status: "missing", detail: "Not detected in current environment" };
    if (current.isGhost || current.healthStatus === "red") {
      return {
        name: s.name,
        status: "not-running",
        actual: "stopped/crashed",
        detail: "Service exists but is not running",
      };
    }
    const currentPorts = (current.ports ?? [])
      .map((p) => p.port)
      .sort()
      .join(",");
    const expectedPorts = (s.ports ?? []).sort().join(",");
    if (expectedPorts && currentPorts !== expectedPorts) {
      return {
        name: s.name,
        status: "wrong-port",
        expected: `port ${expectedPorts}`,
        actual: `port ${currentPorts}`,
        detail: `Expected port ${expectedPorts}, running on ${currentPorts}`,
      };
    }
    return { name: s.name, status: "ok" };
  });

  const currentContainers = new Map();
  for (const c of snapshot.docker?.containers ?? []) {
    currentContainers.set(c.name.toLowerCase(), c);
  }

  const containerResults = blueprint.containers.map((c) => {
    const current = currentContainers.get(c.name.toLowerCase());
    if (!current) return { name: c.name, status: "missing", detail: "Container not found" };
    if (current.state !== "running") {
      return {
        name: c.name,
        status: "not-running",
        actual: current.state,
        detail: `Container is ${current.state}`,
      };
    }
    const currentTag = (current.image || "").split(":")[1] || "latest";
    if (c.imageTag !== "latest" && currentTag !== c.imageTag) {
      return {
        name: c.name,
        status: "wrong-version",
        expected: `${c.image}:${c.imageTag}`,
        actual: `${c.image}:${currentTag}`,
        detail: `Expected ${c.imageTag}, running ${currentTag}`,
      };
    }
    return { name: c.name, status: "ok" };
  });

  const currentKeys = new Set(extractEnvKeys(projectPath));
  const envResults = blueprint.requiredEnvKeys.map((key) => {
    if (currentKeys.has(key)) return { name: key, status: "ok" };
    return { name: key, status: "missing", detail: "Not found in any .env file" };
  });

  const allItems = [...serviceResults, ...containerResults, ...envResults];
  const okCount = allItems.filter((i) => i.status === "ok").length;
  const missingCount = allItems.filter((i) => i.status === "missing").length;
  const wrongCount = allItems.filter((i) =>
    ["wrong-version", "wrong-port", "not-running"].includes(i.status),
  ).length;
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

module.exports = { saveBlueprint, loadBlueprint, deleteBlueprint, checkBlueprint };
