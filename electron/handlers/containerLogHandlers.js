/**
 * Container log streaming IPC handlers.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
function registerContainerLogHandlers(ipcMain, {
  startLogStream,
  stopLogStream,
  registerSenderLogStream,
  unregisterSenderLogStream,
  getActiveStreams,
  stopContainerStreams,
  stopAllStreams,
  unregisterLogStreamEverywhere,
  getLogStreamsBySender,
  agentDockerLogs,
  analytics,
}) {
  ipcMain.handle(
    "start-container-logs",
    async (event, containerId, options = {}) => {
      try {
        const sender = event.sender;
        const safeSend = (channel, payload) => {
          if (!sender || sender.isDestroyed()) return false;
          try {
            sender.send(channel, payload);
            return true;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes("Object has been destroyed")) {
              console.error(`Error sending ${channel} to renderer:`, err);
            }
            return false;
          }
        };

        // Bug 24 fix: callbacks use only the streamId provided by startLogStream
        // (via logData.streamId or the sid parameter), never the outer variable
        // which may still be unassigned if data arrives before the await resolves.
        const streamId = await startLogStream(
          containerId,
          options,
          (logData) => {
            if (!safeSend("container-log-data", logData)) {
              if (logData.streamId) stopLogStream(logData.streamId);
            }
          },
          (error, sid) => {
            if (
              !safeSend("container-log-error", {
                streamId: sid,
                containerId,
                error: error.message,
              })
            ) {
              if (sid) stopLogStream(sid);
            }
          },
          (code, sid) => {
            const id = sid || streamId;
            if (id) unregisterSenderLogStream(sender, id);
            safeSend("container-log-close", {
              streamId: id,
              containerId,
              exitCode: code,
            });
          },
        );

        registerSenderLogStream(sender, streamId);
        analytics.capture("container_logs_started");
        return { success: true, streamId };
      } catch (error) {
        console.error("Error starting container logs:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("stop-container-logs", async (_, streamId) => {
    try {
      const stopped = stopLogStream(streamId);
      unregisterLogStreamEverywhere(streamId);
      return { success: stopped };
    } catch (error) {
      console.error("Error stopping container logs:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-container-streams", async (_, containerId) => {
    try {
      const beforeActive = new Set(
        getActiveStreams().map((stream) => stream.streamId),
      );
      const count = stopContainerStreams(containerId);
      const afterActive = new Set(
        getActiveStreams().map((stream) => stream.streamId),
      );
      beforeActive.forEach((id) => {
        if (!afterActive.has(id)) unregisterLogStreamEverywhere(id);
      });
      return { success: true, count };
    } catch (error) {
      console.error("Error stopping container streams:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-all-container-logs", async () => {
    try {
      const logStreamsBySender = getLogStreamsBySender();
      const allStreamIds = Array.from(logStreamsBySender.values()).flatMap(
        (entry) => Array.from(entry.streamIds),
      );
      stopAllStreams();
      allStreamIds.forEach((id) => unregisterLogStreamEverywhere(id));
      return { success: true };
    } catch (error) {
      console.error("Error stopping all container logs:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-container-log-tail", async (_, containerId, tail = 20) => {
    try {
      const logs = await agentDockerLogs(containerId, tail);
      return { success: true, logs };
    } catch (err) {
      return { success: false, logs: "" };
    }
  });
}

module.exports = { registerContainerLogHandlers };
