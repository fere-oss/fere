/**
 * Database IPC handlers — containerized DB operations and remote URI connections.
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
function registerDatabaseHandlers(
  ipcMain,
  {
    getDatabaseTables,
    getTableData,
    executeQuery,
    createTable,
    connectMongoUri,
    getMongoUriCollectionData,
    executeMongoUriQuery,
    connectPostgresUri,
    getPostgresUriTableData,
    executePostgresUriQuery,
    connectElasticsearchUri,
    getElasticsearchUriIndexData,
    executeElasticsearchUriQuery,
    validateRemoteDbUri,
    analytics,
  },
) {
  function validateDbParams(containerId, containerImage) {
    if (!containerId || typeof containerId !== "string") return "Invalid container ID";
    if (!containerImage || typeof containerImage !== "string") return "Invalid container image";
    return null;
  }

  ipcMain.handle("get-database-tables", async (_, containerId, containerImage) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, tables: [] };
    try {
      return await getDatabaseTables(containerId, containerImage);
    } catch (error) {
      console.error("Error getting database tables:", error);
      return { error: error.message, tables: [] };
    }
  });

  ipcMain.handle("get-table-data", async (_, containerId, containerImage, tableName, limit) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, columns: [], rows: [] };
    if (!tableName || typeof tableName !== "string") {
      return { error: "Invalid table name", columns: [], rows: [] };
    }
    try {
      return await getTableData(containerId, containerImage, tableName, limit || 100);
    } catch (error) {
      console.error("Error getting table data:", error);
      return { error: error.message, columns: [], rows: [] };
    }
  });

  ipcMain.handle("execute-database-query", async (_, containerId, containerImage, query) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, result: null };
    if (!query || typeof query !== "string") return { error: "Invalid query", result: null };
    try {
      const result = await executeQuery(containerId, containerImage, query);
      analytics.capture("database_query_executed", {
        db_type: (containerImage || "").includes("mongo") ? "mongodb" : "sql",
        success: !result.error,
      });
      return result;
    } catch (error) {
      console.error("Error executing database query:", error);
      return { error: error.message, result: null };
    }
  });

  ipcMain.handle(
    "create-database-table",
    async (_, containerId, containerImage, tableName, columns) => {
      const err = validateDbParams(containerId, containerImage);
      if (err) return { error: err, success: false };
      if (!tableName || typeof tableName !== "string")
        return { error: "Invalid table name", success: false };
      if (!Array.isArray(columns) || columns.length === 0)
        return { error: "Invalid columns", success: false };
      try {
        return await createTable(containerId, containerImage, tableName, columns);
      } catch (error) {
        console.error("Error creating database table:", error);
        return { error: error.message, success: false };
      }
    },
  );

  ipcMain.handle("connect-mongo-uri", async (_, uri) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid) return { error: check.reason, tables: [], dbType: "mongodb" };
    try {
      const result = await connectMongoUri(uri);
      analytics.capture("database_connected", {
        db_type: "mongodb",
        mode: "remote_uri",
        success: !result.error,
      });
      return result;
    } catch (error) {
      console.error("Error connecting Mongo URI:", error);
      return { error: error.message, tables: [], dbType: "mongodb" };
    }
  });

  ipcMain.handle("get-mongo-uri-collection-data", async (_, uri, collectionName, limit) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid) return { error: check.reason, columns: [], rows: [], dbType: "mongodb" };
    try {
      return await getMongoUriCollectionData(uri, collectionName, limit || 100);
    } catch (error) {
      console.error("Error loading Mongo URI collection data:", error);
      return { error: error.message, columns: [], rows: [], dbType: "mongodb" };
    }
  });

  ipcMain.handle("execute-mongo-uri-query", async (_, uri, command) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid) return { error: check.reason, dbType: "mongodb" };
    try {
      return await executeMongoUriQuery(uri, command);
    } catch (error) {
      console.error("Error executing Mongo URI query:", error);
      return { error: error.message, dbType: "mongodb" };
    }
  });

  ipcMain.handle("connect-postgres-uri", async (_, uri) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid) return { error: check.reason, tables: [], dbType: "postgresql" };
    try {
      const result = await connectPostgresUri(uri);
      analytics.capture("database_connected", {
        db_type: "postgresql",
        mode: "remote_uri",
        success: !result.error,
      });
      return result;
    } catch (error) {
      console.error("Error connecting Postgres URI:", error);
      return { error: error.message, tables: [], dbType: "postgresql" };
    }
  });

  ipcMain.handle("get-postgres-uri-table-data", async (_, uri, tableName, limit) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid) return { error: check.reason, columns: [], rows: [], dbType: "postgresql" };
    try {
      return await getPostgresUriTableData(uri, tableName, limit || 100);
    } catch (error) {
      console.error("Error loading Postgres URI table data:", error);
      return { error: error.message, columns: [], rows: [], dbType: "postgresql" };
    }
  });

  ipcMain.handle("execute-postgres-uri-query", async (_, uri, query) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid) return { error: check.reason, dbType: "postgresql" };
    try {
      return await executePostgresUriQuery(uri, query);
    } catch (error) {
      console.error("Error executing Postgres URI query:", error);
      return { error: error.message, dbType: "postgresql" };
    }
  });

  ipcMain.handle("connect-elasticsearch-uri", async (_, baseUrl) => {
    const check = validateRemoteDbUri(baseUrl);
    if (!check.valid) return { error: check.reason, tables: [], dbType: "elasticsearch" };
    try {
      const result = await connectElasticsearchUri(baseUrl);
      analytics.capture("database_connected", {
        db_type: "elasticsearch",
        mode: "remote_uri",
        success: !result.error,
      });
      return result;
    } catch (error) {
      console.error("Error connecting Elasticsearch URI:", error);
      return { error: error.message, tables: [], dbType: "elasticsearch" };
    }
  });

  ipcMain.handle("get-elasticsearch-uri-index-data", async (_, baseUrl, indexName, limit) => {
    const check = validateRemoteDbUri(baseUrl);
    if (!check.valid)
      return { error: check.reason, columns: [], rows: [], dbType: "elasticsearch" };
    try {
      return await getElasticsearchUriIndexData(baseUrl, indexName, limit || 100);
    } catch (error) {
      console.error("Error loading Elasticsearch URI index data:", error);
      return { error: error.message, columns: [], rows: [], dbType: "elasticsearch" };
    }
  });

  ipcMain.handle("execute-elasticsearch-uri-query", async (_, baseUrl, query) => {
    const check = validateRemoteDbUri(baseUrl);
    if (!check.valid) return { error: check.reason, dbType: "elasticsearch" };
    try {
      return await executeElasticsearchUriQuery(baseUrl, query);
    } catch (error) {
      console.error("Error executing Elasticsearch URI query:", error);
      return { error: error.message, dbType: "elasticsearch" };
    }
  });
}

module.exports = { registerDatabaseHandlers };
