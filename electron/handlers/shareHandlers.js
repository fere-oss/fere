const path = require("path");
const os = require("os");
const fs = require("fs");

/**
 * Share IPC handlers — GitHub Gist publishing, local graph export,
 * and GitHub token management.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
const SHARE_SETTINGS_FILE = path.join(os.homedir(), ".fere", "settings.json");

function readShareSettings() {
  try {
    if (fs.existsSync(SHARE_SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SHARE_SETTINGS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function writeShareSettings(patch) {
  const dir = path.join(os.homedir(), ".fere");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readShareSettings();
  const merged = { ...existing, ...patch };
  const tmp = SHARE_SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
  fs.renameSync(tmp, SHARE_SETTINGS_FILE);
}

function registerShareHandlers(ipcMain, {
  generateHTML,
  createGist,
  updateGist,
  buildPreviewUrl,
  dialog,
  getMainWindow,
}) {

  function readLogoDevToken() {
    // REACT_APP_ vars aren't loaded into Electron main by CRA — read .env directly
    let logoDevToken = process.env.REACT_APP_LOGO_DEV_TOKEN || "";
    if (!logoDevToken) {
      try {
        const envPath = path.join(__dirname, "../../.env");
        const envContent = fs.readFileSync(envPath, "utf8");
        const m = envContent.match(/^REACT_APP_LOGO_DEV_TOKEN=(.+)$/m);
        if (m) logoDevToken = m[1].trim();
      } catch {}
    }
    return logoDevToken;
  }

  async function doPublish({ graphData, metadata }, isUpdate) {
    const settings = readShareSettings();
    const token = settings.githubToken;
    if (!token) {
      throw new Error("No GitHub token configured. Please add one in the Share settings.");
    }
    const logoDevToken = readLogoDevToken();
    const html = await generateHTML({ graphData, metadata, logoDevToken });

    let result;
    if (isUpdate && settings.shareGistId) {
      result = await updateGist(settings.shareGistId, html, token);
    } else {
      result = await createGist(html, token);
    }

    const previewUrl = buildPreviewUrl(result.rawUrl);
    const publishedAt = Date.now();

    writeShareSettings({
      shareGistId: result.gistId,
      shareUrl: previewUrl,
      sharePublishedAt: publishedAt,
    });

    return { url: previewUrl, publishedAt };
  }

  ipcMain.handle("get-share-settings", () => {
    const settings = readShareSettings();
    return {
      hasToken: !!settings.githubToken,
      shareUrl: settings.shareUrl || null,
      publishedAt: settings.sharePublishedAt || null,
    };
  });

  ipcMain.handle("save-github-token", async (_, token) => {
    try {
      if (!token || typeof token !== "string") throw new Error("Invalid token");
      writeShareSettings({ githubToken: token.trim() });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("export-graph-file", async (_, { graphData, metadata }) => {
    try {
      const logoDevToken = readLogoDevToken();
      const html = await generateHTML({ graphData, metadata, logoDevToken });
      const tabName = (metadata.tabName || "service-map").replace(/[^a-zA-Z0-9_-]/g, "-");
      const { app } = require("electron");
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: "Save Service Map",
        defaultPath: path.join(app.getPath("downloads"), `fere-${tabName}.html`),
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (result.canceled || !result.filePath) return { success: false };
      fs.writeFileSync(result.filePath, html, "utf8");
      return { success: true, filePath: result.filePath };
    } catch (err) {
      console.error("export-graph-file error:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("publish-graph", async (_, options) => {
    try {
      return await doPublish(options, false);
    } catch (err) {
      console.error("publish-graph error:", err);
      return { error: err.message };
    }
  });

  ipcMain.handle("update-shared-graph", async (_, options) => {
    try {
      return await doPublish(options, true);
    } catch (err) {
      console.error("update-shared-graph error:", err);
      return { error: err.message };
    }
  });
}

module.exports = { registerShareHandlers, readShareSettings };
