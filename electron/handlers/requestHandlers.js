/**
 * HTTP request and history IPC handlers — execute-http-request,
 * execute-traced-request, and request history management.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
function registerRequestHandlers(ipcMain, {
  validateHttpRequestUrl,
  getNetworkPolicy,
  executeTracedRequest,
  loadHistory,
  saveHistoryEntry,
  clearHistory,
  analytics,
  MAX_RESPONSE_SIZE,
}) {
  // Note: This app tests local dev services, so localhost is allowed.
  // For apps that must block SSRF entirely, set allowPrivate to false.
  ipcMain.handle("execute-http-request", async (event, options) => {
    try {
      const { method, url, headers, body } = options;

      const allowPrivate = getNetworkPolicy() === "local";
      const validation = validateHttpRequestUrl(url, allowPrivate);
      if (!validation.valid) {
        console.warn("[Security] Blocked HTTP request:", url, "-", validation.reason);
        return { success: false, error: validation.reason };
      }

      const parsedUrl = validation.url;
      const isHttps = parsedUrl.protocol === "https:";
      const httpModule = isHttps ? require("https") : require("http");

      return new Promise((resolve) => {
        const startTime = Date.now();
        const normalizedMethod = (method || "GET").toUpperCase();
        const requestHeaders = { ...(headers || {}) };
        const shouldSendBody =
          typeof body === "string" &&
          body.length > 0 &&
          !["GET", "HEAD"].includes(normalizedMethod);

        if (
          shouldSendBody &&
          !Object.keys(requestHeaders).some(
            (k) => k.toLowerCase() === "content-length",
          )
        ) {
          requestHeaders["Content-Length"] = Buffer.byteLength(body, "utf8").toString();
        }

        const requestOptions = {
          method: normalizedMethod,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          headers: requestHeaders,
          timeout: 30000,
        };

        const req = httpModule.request(requestOptions, (res) => {
          const chunks = [];
          let totalSize = 0;
          let resolved = false;

          res.on("data", (chunk) => {
            totalSize += chunk.length;
            if (totalSize > MAX_RESPONSE_SIZE) {
              resolved = true;
              req.destroy();
              resolve({
                success: false,
                error: `Response too large (exceeded ${MAX_RESPONSE_SIZE / 1024 / 1024}MB limit)`,
              });
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            if (resolved) return;
            const duration = Date.now() - startTime;
            const responseBody = Buffer.concat(chunks).toString("utf8");

            let parsedBody = responseBody;
            let isJson = false;
            const contentType = res.headers["content-type"] || "";
            const JSON_PRETTY_PRINT_LIMIT = 2 * 1024 * 1024;
            if (contentType.includes("application/json")) {
              isJson = true;
              if (responseBody.length <= JSON_PRETTY_PRINT_LIMIT) {
                try {
                  parsedBody = JSON.stringify(JSON.parse(responseBody), null, 2);
                } catch (e) {
                  // Keep as raw string
                }
              }
            }

            analytics.capture("http_request_executed", {
              method: normalizedMethod,
              status: res.statusCode,
              duration,
              success: true,
            });

            resolve({
              success: true,
              response: {
                status: res.statusCode,
                statusText: res.statusMessage,
                headers: res.headers,
                body: parsedBody,
                isJson,
                duration,
                size: totalSize,
              },
            });
          });
        });

        req.on("error", (error) => {
          analytics.capture("http_request_executed", {
            method: normalizedMethod,
            success: false,
            error_type: error.code || "unknown",
          });
          resolve({ success: false, error: error.message });
        });

        req.on("timeout", () => {
          req.destroy();
          resolve({ success: false, error: "Request timed out (30s)" });
        });

        if (shouldSendBody) {
          req.write(body);
        }
        req.end();
      });
    } catch (error) {
      console.error("Error executing HTTP request:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("execute-traced-request", async (event, options) => {
    try {
      const { method, url, headers, body, graphNodes, graphEdges } = options;

      if (!url || typeof url !== "string") {
        return { success: false, error: "URL is required" };
      }
      if (!Array.isArray(graphNodes)) {
        return { success: false, error: "graphNodes must be an array" };
      }

      const allowPrivate = getNetworkPolicy() === "local";
      const validation = validateHttpRequestUrl(url, allowPrivate);
      if (!validation.valid) {
        return { success: false, error: validation.reason };
      }

      const parsedUrl = validation.url;
      const isHttps = parsedUrl.protocol === "https:";
      const httpModule = isHttps ? require("https") : require("http");

      const makeRequest = () => {
        return new Promise((resolve, reject) => {
          const startTime = Date.now();
          const normalizedMethod = (method || "GET").toUpperCase();
          const requestHeaders = { ...(headers || {}) };
          const shouldSendBody =
            typeof body === "string" &&
            body.length > 0 &&
            !["GET", "HEAD"].includes(normalizedMethod);

          if (
            shouldSendBody &&
            !Object.keys(requestHeaders).some(
              (k) => k.toLowerCase() === "content-length",
            )
          ) {
            requestHeaders["Content-Length"] = Buffer.byteLength(body, "utf8").toString();
          }

          const requestOptions = {
            method: normalizedMethod,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            headers: requestHeaders,
            timeout: 30000,
          };

          const req = httpModule.request(requestOptions, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                status: res.statusCode,
                statusText: res.statusMessage,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8"),
                duration: Date.now() - startTime,
              });
            });
          });

          req.on("error", reject);
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timed out"));
          });

          if (shouldSendBody) {
            req.write(body);
          }
          req.end();
        });
      };

      const trace = await executeTracedRequest(
        { method, url, headers, body, graphNodes, graphEdges: graphEdges || [] },
        makeRequest,
      );

      return { success: true, trace };
    } catch (error) {
      console.error("Error executing traced request:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("load-request-history", async () => {
    try {
      return loadHistory();
    } catch (error) {
      console.error("Error loading request history:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("save-request-history", async (event, entry) => {
    try {
      if (!entry || !entry.id || !entry.url || !entry.method) {
        return { success: false, error: "Invalid history entry" };
      }
      return saveHistoryEntry(entry);
    } catch (error) {
      console.error("Error saving request history:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("clear-request-history", async () => {
    try {
      return clearHistory();
    } catch (error) {
      console.error("Error clearing request history:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerRequestHandlers };
