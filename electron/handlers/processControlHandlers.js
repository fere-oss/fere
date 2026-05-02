const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// Allowlisted binaries for start-process (prevents arbitrary command execution)
const ALLOWED_BINARIES = new Set([
  // Node.js / JavaScript
  "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "tsx", "ts-node",
  // Python
  "python", "python3", "pip", "pip3", "uvicorn", "gunicorn", "flask",
  "django-admin", "poetry", "pipenv", "uv",
  // Ruby
  "ruby", "rails", "bundle", "bundler", "rake", "puma",
  // Java / JVM
  "java", "javac", "mvn", "mvnw", "gradle", "gradlew", "./gradlew", "./mvnw",
  // Go
  "go", "air",
  // Rust
  "cargo", "rustc",
  // PHP
  "php", "composer", "artisan",
  // .NET
  "dotnet",
  // Elixir / Erlang
  "mix", "elixir", "iex",
  // Docker (compose only)
  "docker-compose",
  // General
  "make",
]);

/**
 * Parse a command string into [binary, ...args] without using a shell.
 * Supports simple quoting (single and double quotes).
 */
function parseCommand(command) {
  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  if (inSingle || inDouble || escaped) {
    return null;
  }

  return args;
}

/**
 * Process and container control IPC handlers — kill, start, stop, restart.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
function registerProcessControlHandlers(ipcMain, {
  getProcessByPid,
  killProcess,
  markIntentionalStopForPid,
  stopContainer,
  startContainer,
  restartContainer,
  startComposeProject,
  markIntentionalStopForContainer,
  logActivityEvent,
  getAlertNodeMap,
  clearProcessCache,
  clearPortCache,
  getSnapshotScheduler,
  analytics,
}) {
  ipcMain.handle("kill-process", async (event, pid) => {
    try {
      if (!Number.isInteger(pid) || pid <= 0) {
        return { success: false, error: "Invalid PID" };
      }
      const proc = await getProcessByPid(pid);
      if (!proc) {
        return { success: false, error: "Process not found or already terminated" };
      }
      const result = await killProcess(pid);
      analytics.capture("process_killed", { success: result.success });
      if (result.success) {
        logActivityEvent({
          category: "user-action",
          severity: "info",
          title: `Killed process ${proc.name || pid} (PID ${pid})`,
          serviceName: proc.name || null,
          serviceId: null,
          projectName: proc.project || null,
        });
        markIntentionalStopForPid(pid);
        clearProcessCache();
        clearPortCache();
        const scheduler = getSnapshotScheduler();
        if (scheduler) setImmediate(() => scheduler.reconcile());
      }
      return result;
    } catch (error) {
      console.error("Error killing process:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-container", async (event, containerId) => {
    try {
      if (!containerId || typeof containerId !== "string") {
        return { success: false, error: "Invalid container ID" };
      }
      const result = await stopContainer(containerId);
      if (result.success) {
        const alertNodeMap = getAlertNodeMap();
        const node = alertNodeMap.get(containerId);
        logActivityEvent({
          category: "user-action",
          severity: "info",
          title: `Stopped container ${node?.name || containerId.slice(0, 12)}`,
          serviceName: node?.name || null,
          serviceId: null,
          projectName: node?.project || null,
        });
        markIntentionalStopForContainer(containerId);
        clearProcessCache();
        clearPortCache();
        const scheduler = getSnapshotScheduler();
        if (scheduler) setImmediate(() => scheduler.reconcile());
      }
      return result;
    } catch (error) {
      console.error("Error stopping container:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("start-container", async (event, containerId) => {
    try {
      if (!containerId || typeof containerId !== "string") {
        return { success: false, error: "Invalid container ID" };
      }
      const result = await startContainer(containerId);
      if (result.success) {
        const alertNodeMap = getAlertNodeMap();
        const node = alertNodeMap.get(containerId);
        logActivityEvent({
          category: "user-action",
          severity: "info",
          title: `Started container ${node?.name || containerId.slice(0, 12)}`,
          serviceName: node?.name || null,
          serviceId: null,
          projectName: node?.project || null,
        });
        clearProcessCache();
        clearPortCache();
        const scheduler = getSnapshotScheduler();
        if (scheduler) setImmediate(() => scheduler.reconcile());
      }
      return result;
    } catch (error) {
      console.error("Error starting container:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("restart-container", async (event, containerId) => {
    try {
      if (!containerId || typeof containerId !== "string") {
        return { success: false, error: "Invalid container ID" };
      }
      const result = await restartContainer(containerId);
      if (result.success) {
        clearProcessCache();
        clearPortCache();
        const scheduler = getSnapshotScheduler();
        if (scheduler) setImmediate(() => scheduler.reconcile());
      }
      return result;
    } catch (error) {
      console.error("Error restarting container:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("start-compose-project", async (event, composeFilePath, services) => {
    try {
      if (!composeFilePath || typeof composeFilePath !== "string") {
        return { success: false, error: "Invalid compose file path" };
      }
      const serviceList = Array.isArray(services) ? services : [];
      const result = await startComposeProject(composeFilePath, serviceList);
      if (result.success) {
        clearProcessCache();
        clearPortCache();
        const scheduler = getSnapshotScheduler();
        if (scheduler) setImmediate(() => scheduler.reconcile());
      }
      return result;
    } catch (error) {
      console.error("Error starting compose project:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("start-process", async (event, command, cwd) => {
    try {
      if (!command || typeof command !== "string") {
        return { success: false, error: "Invalid command" };
      }
      if (!cwd || typeof cwd !== "string") {
        return { success: false, error: "Invalid working directory" };
      }

      try {
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) {
          return { success: false, error: "Working directory is not a directory" };
        }
      } catch {
        return { success: false, error: "Working directory does not exist" };
      }

      if (/[|;&`$><\n]/.test(command)) {
        return { success: false, error: "Command contains disallowed shell metacharacters" };
      }

      const parts = parseCommand(command);
      if (!parts) {
        return { success: false, error: "Malformed command (unmatched quote or escape)" };
      }
      if (parts.length === 0) {
        return { success: false, error: "Empty command" };
      }

      const requestedBinary = parts[0];
      const binary = path.basename(requestedBinary);

      const usesPath = requestedBinary.includes("/") || requestedBinary.includes("\\");
      const isAllowedWrapper =
        requestedBinary === "./gradlew" || requestedBinary === "./mvnw";
      if (usesPath && !isAllowedWrapper) {
        return { success: false, error: "Binary path must be a known wrapper or bare command" };
      }

      if (!ALLOWED_BINARIES.has(binary)) {
        console.warn(`start-process: blocked disallowed binary "${requestedBinary}"`);
        return { success: false, error: `Binary "${binary}" is not in the allowlist` };
      }

      let spawnBinary = requestedBinary;
      if (isAllowedWrapper) {
        const wrapperPath = path.resolve(cwd, requestedBinary);
        if (!wrapperPath.startsWith(path.resolve(cwd) + path.sep)) {
          return { success: false, error: "Invalid wrapper path" };
        }
        try {
          fs.accessSync(wrapperPath, fs.constants.X_OK);
        } catch {
          return { success: false, error: `Wrapper script not executable: ${requestedBinary}` };
        }
        spawnBinary = wrapperPath;
      }

      const child = spawn(spawnBinary, parts.slice(1), {
        cwd,
        detached: true,
        stdio: "ignore",
      });

      // Wait briefly to catch early spawn failures (ENOENT, EACCES) before reporting success.
      const launched = await new Promise((resolve) => {
        const onError = (err) => { cleanup(); resolve({ ok: false, error: err.message }); };
        const onSpawn = () => { cleanup(); resolve({ ok: true }); };
        const timeout = setTimeout(() => {
          cleanup();
          resolve({ ok: true });
        }, 2000);
        function cleanup() {
          clearTimeout(timeout);
          child.removeListener("error", onError);
          child.removeListener("spawn", onSpawn);
        }
        child.once("error", onError);
        child.once("spawn", onSpawn);
      });

      if (!launched.ok) {
        return { success: false, error: launched.error };
      }

      child.unref();
      const pid = child.pid;
      logActivityEvent({
        category: "user-action",
        severity: "info",
        title: `Started process: ${command}`,
        detail: `PID ${pid}, cwd: ${cwd}`,
        serviceName: null,
        serviceId: null,
        projectName: cwd || null,
      });
      clearProcessCache();
      clearPortCache();
      const scheduler = getSnapshotScheduler();
      if (scheduler) setImmediate(() => scheduler.reconcile());
      return { success: true, pid };
    } catch (error) {
      console.error("Error starting process:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerProcessControlHandlers, ALLOWED_BINARIES, parseCommand };
