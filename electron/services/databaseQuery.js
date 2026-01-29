const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

/**
 * Detect database type from container image name
 */
function detectDatabaseType(image) {
  const imageLower = image.toLowerCase();
  if (imageLower.includes('postgres') || imageLower.includes('pg')) return 'postgresql';
  if (imageLower.includes('mysql') || imageLower.includes('mariadb')) return 'mysql';
  if (imageLower.includes('mongo')) return 'mongodb';
  return null;
}

/**
 * Get list of tables/collections from a database container
 */
async function getDatabaseTables(containerId, containerImage) {
  const dbType = detectDatabaseType(containerImage);
  if (!dbType) {
    return { error: 'Unsupported database type', tables: [] };
  }

  try {
    switch (dbType) {
      case 'postgresql':
        return await getPostgresTables(containerId);
      case 'mysql':
        return await getMySQLTables(containerId);
      case 'mongodb':
        return await getMongoCollections(containerId);
      default:
        return { error: 'Unsupported database type', tables: [] };
    }
  } catch (error) {
    return { error: error.message, tables: [] };
  }
}

/**
 * Get table data from a database container
 */
async function getTableData(containerId, containerImage, tableName, limit = 100) {
  const dbType = detectDatabaseType(containerImage);
  if (!dbType) {
    return { error: 'Unsupported database type', columns: [], rows: [] };
  }

  try {
    switch (dbType) {
      case 'postgresql':
        return await getPostgresTableData(containerId, tableName, limit);
      case 'mysql':
        return await getMySQLTableData(containerId, tableName, limit);
      case 'mongodb':
        return await getMongoCollectionData(containerId, tableName, limit);
      default:
        return { error: 'Unsupported database type', columns: [], rows: [] };
    }
  } catch (error) {
    return { error: error.message, columns: [], rows: [] };
  }
}

// PostgreSQL functions
async function getPostgresTables(containerId) {
  const cmd = `docker exec ${containerId} psql -U postgres -t -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;" 2>/dev/null`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const tables = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return { tables, dbType: 'postgresql' };
  } catch (error) {
    // Try with different user or database
    const altCmd = `docker exec ${containerId} psql -t -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;" 2>/dev/null`;
    try {
      const { stdout } = await execAsync(altCmd, { timeout: 10000 });
      const tables = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      return { tables, dbType: 'postgresql' };
    } catch {
      throw error;
    }
  }
}

async function getPostgresTableData(containerId, tableName, limit) {
  // Sanitize table name to prevent injection
  const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');

  // Get columns first
  const colCmd = `docker exec ${containerId} psql -U postgres -t -c "SELECT column_name FROM information_schema.columns WHERE table_name = '${safeTableName}' ORDER BY ordinal_position;" 2>/dev/null`;
  const { stdout: colOut } = await execAsync(colCmd, { timeout: 10000 });
  const columns = colOut
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Get data as JSON
  const dataCmd = `docker exec ${containerId} psql -U postgres -t -c "SELECT row_to_json(t) FROM (SELECT * FROM ${safeTableName} LIMIT ${limit}) t;" 2>/dev/null`;
  const { stdout: dataOut } = await execAsync(dataCmd, { timeout: 15000 });

  const rows = dataOut
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(row => row !== null);

  return { columns, rows, dbType: 'postgresql', tableName: safeTableName };
}

// MySQL functions
async function getMySQLTables(containerId) {
  const cmd = `docker exec ${containerId} mysql -u root -e "SHOW TABLES;" --skip-column-names 2>/dev/null`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const tables = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return { tables, dbType: 'mysql' };
  } catch (error) {
    // Try to find the database name first
    const dbCmd = `docker exec ${containerId} mysql -u root -e "SHOW DATABASES;" --skip-column-names 2>/dev/null`;
    try {
      const { stdout: dbOut } = await execAsync(dbCmd, { timeout: 10000 });
      const databases = dbOut.split('\n').map(l => l.trim()).filter(l => l && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(l));

      if (databases.length > 0) {
        const tableCmd = `docker exec ${containerId} mysql -u root -D ${databases[0]} -e "SHOW TABLES;" --skip-column-names 2>/dev/null`;
        const { stdout } = await execAsync(tableCmd, { timeout: 10000 });
        const tables = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        return { tables, dbType: 'mysql', database: databases[0] };
      }
    } catch {
      throw error;
    }
    throw error;
  }
}

async function getMySQLTableData(containerId, tableName, limit) {
  const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');

  // Get columns
  const colCmd = `docker exec ${containerId} mysql -u root -e "DESCRIBE ${safeTableName};" --skip-column-names 2>/dev/null`;
  const { stdout: colOut } = await execAsync(colCmd, { timeout: 10000 });
  const columns = colOut
    .split('\n')
    .map(line => line.split('\t')[0]?.trim())
    .filter(col => col && col.length > 0);

  // Get data as JSON
  const dataCmd = `docker exec ${containerId} mysql -u root -e "SELECT * FROM ${safeTableName} LIMIT ${limit};" --batch 2>/dev/null`;
  const { stdout: dataOut } = await execAsync(dataCmd, { timeout: 15000 });

  const lines = dataOut.split('\n').filter(l => l.trim().length > 0);
  const headers = lines[0]?.split('\t') || [];
  const rows = lines.slice(1).map(line => {
    const values = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] || null;
    });
    return row;
  });

  return { columns: headers, rows, dbType: 'mysql', tableName: safeTableName };
}

// MongoDB functions
async function getMongoCollections(containerId) {
  // Try mongosh first (newer), then mongo (older)
  const commands = [
    `docker exec ${containerId} mongosh --quiet --eval "db.getCollectionNames().forEach(function(c) { print(c) })" 2>/dev/null`,
    `docker exec ${containerId} mongo --quiet --eval "db.getCollectionNames().forEach(function(c) { print(c) })" 2>/dev/null`
  ];

  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      const collections = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('Connecting'));

      if (collections.length > 0) {
        return { tables: collections, dbType: 'mongodb' };
      }
    } catch {
      continue;
    }
  }

  throw new Error('Could not connect to MongoDB');
}

async function getMongoCollectionData(containerId, collectionName, limit) {
  const safeCollectionName = collectionName.replace(/[^a-zA-Z0-9_]/g, '');

  const commands = [
    `docker exec ${containerId} mongosh --quiet --eval "JSON.stringify(db.${safeCollectionName}.find().limit(${limit}).toArray())" 2>/dev/null`,
    `docker exec ${containerId} mongo --quiet --eval "JSON.stringify(db.${safeCollectionName}.find().limit(${limit}).toArray())" 2>/dev/null`
  ];

  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 15000 });
      const cleanOutput = stdout.trim().split('\n').pop(); // Get last line (the JSON)
      const rows = JSON.parse(cleanOutput || '[]');

      // Extract columns from first few rows
      const columnSet = new Set();
      rows.slice(0, 10).forEach(row => {
        Object.keys(row).forEach(key => columnSet.add(key));
      });
      const columns = Array.from(columnSet);

      // Convert ObjectId and other BSON types to strings
      const cleanRows = rows.map(row => {
        const clean = {};
        for (const [key, value] of Object.entries(row)) {
          if (value && typeof value === 'object' && value.$oid) {
            clean[key] = value.$oid;
          } else if (value && typeof value === 'object' && value.$date) {
            clean[key] = new Date(value.$date).toISOString();
          } else {
            clean[key] = value;
          }
        }
        return clean;
      });

      return { columns, rows: cleanRows, dbType: 'mongodb', tableName: safeCollectionName };
    } catch {
      continue;
    }
  }

  throw new Error('Could not query MongoDB collection');
}

/**
 * Execute a raw query/command on a database container
 */
async function executeQuery(containerId, containerImage, query) {
  const dbType = detectDatabaseType(containerImage);
  if (!dbType) {
    return { error: 'Unsupported database type', result: null };
  }

  try {
    switch (dbType) {
      case 'postgresql':
        return await executePostgresQuery(containerId, query);
      case 'mysql':
        return await executeMySQLQuery(containerId, query);
      case 'mongodb':
        return await executeMongoCommand(containerId, query);
      default:
        return { error: 'Unsupported database type', result: null };
    }
  } catch (error) {
    return { error: error.message, result: null };
  }
}

async function executePostgresQuery(containerId, query) {
  // Escape single quotes in the query for shell
  const escapedQuery = query.replace(/'/g, "'\\''");
  const cmd = `docker exec ${containerId} psql -U postgres -c '${escapedQuery}' 2>&1`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
    const output = stdout || stderr;

    // Check if it's a SELECT query - try to parse as JSON
    if (query.trim().toLowerCase().startsWith('select')) {
      const jsonCmd = `docker exec ${containerId} psql -U postgres -t -c "SELECT json_agg(t) FROM (${query.replace(/'/g, "'\\''")} ) t;" 2>&1`;
      try {
        const { stdout: jsonOut } = await execAsync(jsonCmd, { timeout: 30000 });
        const trimmed = jsonOut.trim();
        if (trimmed && trimmed !== 'null') {
          const rows = JSON.parse(trimmed);
          if (Array.isArray(rows) && rows.length > 0) {
            const columns = Object.keys(rows[0]);
            return { columns, rows, rowCount: rows.length, dbType: 'postgresql' };
          }
        }
      } catch {
        // Fall through to text output
      }
    }

    // For non-SELECT queries, return the text output
    return { output, dbType: 'postgresql' };
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

async function executeMySQLQuery(containerId, query) {
  const escapedQuery = query.replace(/'/g, "'\\''");
  const cmd = `docker exec ${containerId} mysql -u root -e '${escapedQuery}' --batch 2>&1`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
    const output = stdout || stderr;

    // Parse tabular output for SELECT queries
    if (query.trim().toLowerCase().startsWith('select')) {
      const lines = output.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const columns = lines[0].split('\t');
        const rows = lines.slice(1).map(line => {
          const values = line.split('\t');
          const row = {};
          columns.forEach((col, i) => {
            row[col] = values[i] || null;
          });
          return row;
        });
        return { columns, rows, rowCount: rows.length, dbType: 'mysql' };
      }
    }

    return { output, dbType: 'mysql' };
  } catch (error) {
    throw new Error(error.stderr || error.message);
  }
}

async function executeMongoCommand(containerId, command) {
  // Try mongosh first, then mongo
  const commands = [
    `docker exec ${containerId} mongosh --quiet --eval '${command.replace(/'/g, "'\\''")}' 2>&1`,
    `docker exec ${containerId} mongo --quiet --eval '${command.replace(/'/g, "'\\''")}' 2>&1`
  ];

  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 30000 });
      const output = stdout.trim();

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) {
          const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
          return { columns, rows: parsed, rowCount: parsed.length, dbType: 'mongodb' };
        }
        return { output: JSON.stringify(parsed, null, 2), dbType: 'mongodb' };
      } catch {
        return { output, dbType: 'mongodb' };
      }
    } catch {
      continue;
    }
  }

  throw new Error('Could not execute MongoDB command');
}

module.exports = {
  detectDatabaseType,
  getDatabaseTables,
  getTableData,
  executeQuery,
};
