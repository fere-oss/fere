/**
 * Settings IPC handlers — network policy, auto-launch, alert preferences,
 * analytics, activity log, metric history, and native theme.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
function registerSettingsHandlers(ipcMain, {
  app,
  nativeTheme,
  getNetworkPolicy,
  setNetworkPolicy,
  getAlertPreferences,
  setAlertPreferences,
  getAlertHistory,
  clearAlertHistory,
  analytics,
  getActivityLog,
  getMetricHistory,
}) {
  ipcMain.handle("get-network-policy", async () => {
    try {
      return { success: true, policy: getNetworkPolicy() };
    } catch (error) {
      console.error("Error getting network policy:", error);
      return { success: true, policy: "local" };
    }
  });

  ipcMain.handle("set-network-policy", async (event, policy) => {
    try {
      if (policy !== "local" && policy !== "public") {
        return { success: false, error: "Policy must be 'local' or 'public'" };
      }
      return setNetworkPolicy(policy);
    } catch (error) {
      console.error("Error setting network policy:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-auto-launch", async () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle("set-auto-launch", async (_event, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-alert-preferences", async () => {
    try {
      return getAlertPreferences();
    } catch (error) {
      console.error("Error getting alert preferences:", error);
      return { alertsEnabled: true };
    }
  });

  ipcMain.handle("set-alert-preferences", async (event, prefs) => {
    try {
      if (typeof prefs !== "object" || prefs === null) {
        return { success: false, error: "Invalid preferences" };
      }
      return setAlertPreferences(prefs);
    } catch (error) {
      console.error("Error setting alert preferences:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-alert-history", async () => {
    try {
      return { success: true, events: getAlertHistory() };
    } catch (error) {
      console.error("Error getting alert history:", error);
      return { success: false, events: [], error: error.message };
    }
  });

  ipcMain.handle("clear-alert-history", async () => {
    try {
      return await clearAlertHistory();
    } catch (error) {
      console.error("Error clearing alert history:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-analytics-id", () => {
    return analytics.getDistinctId();
  });

  ipcMain.handle("get-activity-log", async (event, options) => {
    try {
      return getActivityLog(options || {});
    } catch (error) {
      console.error("Error getting activity log:", error);
      return [];
    }
  });

  ipcMain.handle("get-metric-history", async () => {
    try {
      return getMetricHistory();
    } catch (error) {
      console.error("Error getting metric history:", error);
      return {};
    }
  });

  ipcMain.handle("set-native-theme", (_event, theme) => {
    if (theme === "dark") nativeTheme.themeSource = "dark";
    else nativeTheme.themeSource = "light";
  });
}

module.exports = { registerSettingsHandlers };
