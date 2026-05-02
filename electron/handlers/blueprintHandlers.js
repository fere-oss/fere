/**
 * Blueprint IPC handlers — save/load/delete/check local service blueprints.
 * @param {Electron.IpcMain} ipcMain
 * @param {{ blueprintManager: object }} deps
 */
function registerBlueprintHandlers(ipcMain, { blueprintManager }) {
  ipcMain.handle("blueprint:save", async (_, { snapshot, projectPath, label }) => {
    try {
      return await blueprintManager.saveBlueprint(snapshot, projectPath, label);
    } catch (err) {
      console.error("blueprint:save error:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("blueprint:load", async (_, projectPath) => {
    try {
      return blueprintManager.loadBlueprint(projectPath);
    } catch (err) {
      console.error("blueprint:load error:", err);
      return null;
    }
  });

  ipcMain.handle("blueprint:delete", async (_, projectPath) => {
    try {
      blueprintManager.deleteBlueprint(projectPath);
    } catch (err) {
      console.error("blueprint:delete error:", err);
      throw err;
    }
  });

  ipcMain.handle("blueprint:check", async (_, { projectPath, snapshot }) => {
    try {
      return blueprintManager.checkBlueprint(projectPath, snapshot);
    } catch (err) {
      console.error("blueprint:check error:", err);
      throw err;
    }
  });
}

module.exports = { registerBlueprintHandlers };
