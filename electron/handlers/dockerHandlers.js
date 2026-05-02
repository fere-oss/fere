/**
 * Docker IPC handlers — availability check, container/network queries.
 * @param {Electron.IpcMain} ipcMain
 * @param {{ isDockerAvailable, getDockerContainers, getDockerNetworks, getDockerSnapshot }} deps
 */
function registerDockerHandlers(ipcMain, {
  isDockerAvailable,
  getDockerContainers,
  getDockerNetworks,
  getDockerSnapshot,
}) {
  ipcMain.handle("is-docker-available", async () => {
    try {
      return await isDockerAvailable();
    } catch (error) {
      console.error("Error checking Docker availability:", error);
      return false;
    }
  });

  ipcMain.handle("get-docker-containers", async () => {
    try {
      return await getDockerContainers();
    } catch (error) {
      console.error("Error getting Docker containers:", error);
      return [];
    }
  });

  ipcMain.handle("get-docker-networks", async () => {
    try {
      return await getDockerNetworks();
    } catch (error) {
      console.error("Error getting Docker networks:", error);
      return [];
    }
  });

  ipcMain.handle("get-docker-snapshot", async () => {
    try {
      return await getDockerSnapshot();
    } catch (error) {
      console.error("Error getting Docker snapshot:", error);
      return { containers: [], networks: [], containerConnections: [], isAvailable: false };
    }
  });
}

module.exports = { registerDockerHandlers };
