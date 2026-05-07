const path = require("path");
const fs = require("fs");
const { shell, clipboard, BrowserWindow } = require("electron");

/**
 * Quick action IPC handlers — URL open, clipboard, window maximize,
 * terminal and editor launch.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
function registerQuickActionHandlers(ipcMain, { validateExternalUrl, platform }) {
  ipcMain.handle("open-url", async (event, url) => {
    try {
      const validation = validateExternalUrl(url);
      if (!validation.valid) {
        console.warn("[Security] Blocked open-url request:", url, "-", validation.reason);
        return { success: false, error: validation.reason };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error("Error opening URL:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("copy-text", async (_, text) => {
    try {
      clipboard.writeText(typeof text === "string" ? text : "");
      return { success: true };
    } catch (error) {
      console.error("Error copying text:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("window:toggle-maximize", async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { success: false, error: "Window not found" };
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      return { success: true };
    } catch (error) {
      console.error("Error toggling maximize:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-terminal", async (event, dirPath) => {
    try {
      if (!dirPath || typeof dirPath !== "string") {
        return { success: false, error: "Invalid path" };
      }
      const resolvedPath = path.resolve(dirPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: "Directory does not exist" };
      }
      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        return { success: false, error: "Path is not a directory" };
      }
      return await platform.openTerminalAtPath(resolvedPath);
    } catch (error) {
      console.error("Error opening terminal:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-in-editor", async (event, filePath, line) => {
    try {
      if (!filePath || typeof filePath !== "string") {
        return { success: false, error: "Invalid file path" };
      }
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: "File does not exist" };
      }
      if (!platform.isPathAllowedForEditor(resolvedPath)) {
        return { success: false, error: "Path outside home directory" };
      }
      const { spawn } = require("child_process");
      if (platform.hasCodeEditor()) {
        const lineNum = typeof line === "number" && line > 0 ? line : undefined;
        const gotoArg = lineNum ? `${resolvedPath}:${lineNum}` : resolvedPath;
        const child = spawn("code", ["--goto", gotoArg], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return { success: true, editor: "vscode" };
      }
      return platform.openFileInDefaultApp(resolvedPath);
    } catch (error) {
      console.error("Error opening file in editor:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerQuickActionHandlers };
