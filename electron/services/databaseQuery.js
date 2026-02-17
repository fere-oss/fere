const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DOCKER_EXEC_TIMEOUT_MS = 15000;
const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  'docker',
].filter(Boolean);
let resolvedDockerBin = null;
let PgClient = null;
try {
  ({ Client: PgClient } = require('pg'));
} catch {
  PgClient = null;
}

const VALID_CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function getDockerBinaries() {
  const bins = [];
  for (const bin of DOCKER_BIN_CANDIDATES) {
    if (bin.includes('/') && !fs.existsSync(bin)) continue;
    bins.push(bin);
  }
  return bins.length > 0 ? bins : ['docker'];
}

async function resolveDockerBinary() {
  if (resolvedDockerBin) return resolvedDockerBin;

  const candidates = getDockerBinaries();
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['version', '--format', '{{.Client.Version}}'], {
        timeout: DOCKER_EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      resolvedDockerBin = candidate;
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  resolvedDockerBin = null;
  return null;
}

async function getDockerBinaryOrThrow() {
  const dockerBin = await resolveDockerBinary();
  if (!dockerBin) {
    throw new Error('Docker CLI not found. Tried: ' + getDockerBinaries().join(', '));
  }
  return dockerBin;
}

function validateContainerId(containerId) {
  if (!containerId || typeof containerId !== 'string' || !VALID_CONTAINER_ID.test(containerId)) {
    throw new Error('Invalid container ID');
  }
}

async function execDockerWithInput(containerId, commandArgs, input, timeout = 30000) {
  validateContainerId(containerId);
  const dockerBin = await getDockerBinaryOrThrow();
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin, ['exec', '-i', containerId, ...commandArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('Database command timed out'));
        return;
      }
      if (code !== 0) {
        const err = new Error(stderr || stdout || `Command exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.write(input || '');
    child.stdin.end();
  });
}

async function execDocker(containerId, commandArgs, timeout = 10000) {
  validateContainerId(containerId);
  const dockerBin = await getDockerBinaryOrThrow();
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin, ['exec', containerId, ...commandArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('Docker command timed out'));
        return;
      }
      if (code !== 0) {
        const err = new Error(stderr || stdout || `Command exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function execMongoUriEval(uri, command, timeout = 30000) {
  const dockerBin = await getDockerBinaryOrThrow();
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin, ['run', '--rm', 'mongo:7', 'mongosh', uri, '--quiet', '--eval', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('Remote MongoDB command timed out'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Command exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });

  });
}

function extractJsonCandidate(output, fallback = '[]') {
  const lines = String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // Prefer full JSON lines and ignore shell banners/noise.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if ((line.startsWith('[') && line.endsWith(']')) || (line.startsWith('{') && line.endsWith('}'))) {
      return line;
    }
  }

  return fallback;
}

function parseMongoCollectionLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      if (lower.startsWith('atlas ')) return false;
      if (lower.startsWith('connecting')) return false;
      if (lower.startsWith('using mongodb')) return false;
      if (lower.startsWith('for mongosh info')) return false;
      if (line.startsWith('Current Mongosh Log ID')) return false;
      if (line.startsWith('To help improve')) return false;
      return true;
    });
}

function extractMongoDbNameFromUri(uri) {
  try {
    const parsed = new URL(uri);
    const dbPath = (parsed.pathname || '/').replace(/^\//, '').trim();
    return dbPath || null;
  } catch {
    const match = String(uri || '').match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
    return match?.[1]?.trim() || null;
  }
}

function detectMongoShellError(output) {
  const text = String(output || '').toLowerCase();
  if (text.includes('authentication failed')) return 'MongoDB authentication failed';
  if (text.includes('not authorized')) return 'MongoDB user is not authorized for this database';
  if (text.includes('mongoservererror')) return 'MongoDB server returned an error';
  if (text.includes('bad auth')) return 'MongoDB authentication failed';
  return null;
}

function isPostgresUri(uri) {
  const value = String(uri || '').trim().toLowerCase();
  return value.startsWith('postgresql://') || value.startsWith('postgres://');
}

function sanitizePostgresIdentifier(name) {
  const value = String(name || '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${name}`);
  }
  return value;
}

async function withPostgresUriClient(uri, callback) {
  if (!PgClient) {
    throw new Error('PostgreSQL driver is not installed');
  }
  const client = new PgClient({
    connectionString: uri,
    statement_timeout: 30000,
    query_timeout: 30000,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

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
  const sql = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;";

  try {
    const { stdout } = await execDocker(containerId, ['psql', '-U', 'postgres', '-t', '-c', sql], 10000);
    const tables = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return { tables, dbType: 'postgresql' };
  } catch (error) {
    // Try with different user or database
    try {
      const { stdout } = await execDocker(containerId, ['psql', '-t', '-c', sql], 10000);
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
  const { stdout: colOut } = await execDocker(containerId, [
    'psql', '-U', 'postgres', '-t', '-c',
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${safeTableName}' ORDER BY ordinal_position;`
  ], 10000);
  const columns = colOut
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Get data as JSON
  const { stdout: dataOut } = await execDocker(containerId, [
    'psql', '-U', 'postgres', '-t', '-c',
    `SELECT row_to_json(t) FROM (SELECT * FROM ${safeTableName} LIMIT ${limit}) t;`
  ], 15000);

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
  try {
    const { stdout } = await execDocker(containerId, ['mysql', '-u', 'root', '-e', 'SHOW TABLES;', '--skip-column-names'], 10000);
    const tables = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return { tables, dbType: 'mysql' };
  } catch (error) {
    // Try to find the database name first
    try {
      const { stdout: dbOut } = await execDocker(containerId, ['mysql', '-u', 'root', '-e', 'SHOW DATABASES;', '--skip-column-names'], 10000);
      const databases = dbOut.split('\n').map(l => l.trim()).filter(l => l && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(l));

      if (databases.length > 0) {
        const { stdout } = await execDocker(containerId, ['mysql', '-u', 'root', '-D', databases[0], '-e', 'SHOW TABLES;', '--skip-column-names'], 10000);
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
  const { stdout: colOut } = await execDocker(containerId, [
    'mysql', '-u', 'root', '-e', `DESCRIBE ${safeTableName};`, '--skip-column-names'
  ], 10000);
  const columns = colOut
    .split('\n')
    .map(line => line.split('\t')[0]?.trim())
    .filter(col => col && col.length > 0);

  // Get data as JSON
  const { stdout: dataOut } = await execDocker(containerId, [
    'mysql', '-u', 'root', '-e', `SELECT * FROM ${safeTableName} LIMIT ${limit};`, '--batch'
  ], 15000);

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

// MongoDB auth helper — extract credentials from container environment variables
async function getMongoAuthArgs(containerId) {
  try {
    const { stdout } = await execDocker(containerId, ['env'], 5000);
    const env = {};
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    const user = env.MONGO_INITDB_ROOT_USERNAME;
    const pass = env.MONGO_INITDB_ROOT_PASSWORD;
    if (user && pass) {
      return ['-u', user, '-p', pass, '--authenticationDatabase', 'admin'];
    }
    return [];
  } catch {
    return [];
  }
}

// MongoDB functions
async function getMongoCollections(containerId) {
  // Try mongosh first (newer), then mongo (older).
  // Return empty collections on success instead of treating it as a connection error.
  const authArgs = await getMongoAuthArgs(containerId);
  const commandVariants = [
    ['mongosh', '--quiet', ...authArgs, '--eval', 'print(JSON.stringify(db.getCollectionNames()))'],
    ['mongo', '--quiet', ...authArgs, '--eval', 'print(JSON.stringify(db.getCollectionNames()))'],
  ];

  for (const cmdArgs of commandVariants) {
    try {
      const { stdout } = await execDocker(containerId, cmdArgs, 10000);
      const output = stdout.trim();

      // Preferred path: JSON array output from shell command
      if (output.startsWith('[') && output.endsWith(']')) {
        try {
          const parsed = JSON.parse(output);
          if (Array.isArray(parsed)) {
            const collections = parsed
              .map(name => String(name).trim())
              .filter(name => name.length > 0);
            return { tables: collections, dbType: 'mongodb' };
          }
        } catch {
          // Fall through to legacy line parsing
        }
      }

      // Backward-compatible parsing for shells that don't return clean JSON
      const collections = output
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('Connecting'));
      return { tables: collections, dbType: 'mongodb' };
    } catch {
      continue;
    }
  }

  throw new Error('Could not connect to MongoDB');
}

async function getMongoCollectionData(containerId, collectionName, limit) {
  const safeCollectionName = collectionName.replace(/[^a-zA-Z0-9_]/g, '');
  const authArgs = await getMongoAuthArgs(containerId);

  const commandVariants = [
    ['mongosh', '--quiet', ...authArgs, '--eval', `JSON.stringify(db.${safeCollectionName}.find().limit(${limit}).toArray())`],
    ['mongo', '--quiet', ...authArgs, '--eval', `JSON.stringify(db.${safeCollectionName}.find().limit(${limit}).toArray())`],
  ];

  for (const cmdArgs of commandVariants) {
    try {
      const { stdout } = await execDocker(containerId, cmdArgs, 15000);
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
  try {
    const { stdout, stderr } = await execDockerWithInput(containerId, ['psql', '-U', 'postgres'], query, 30000);
    const output = stdout || stderr;

    // Check if there's an error in the output
    if (output.toLowerCase().includes('error:') || output.toLowerCase().includes('fatal:')) {
      throw new Error(output);
    }

    // Check if it's a SELECT query - try to parse as JSON
    if (query.trim().toLowerCase().startsWith('select')) {
      const jsonQuery = `SELECT json_agg(t) FROM (${query}) t;`;
      try {
        const { stdout: jsonOut } = await execDockerWithInput(containerId, ['psql', '-U', 'postgres', '-t'], jsonQuery, 30000);
        const trimmed = jsonOut.trim();
        if (trimmed && trimmed !== 'null' && !trimmed.toLowerCase().includes('error:')) {
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
    throw new Error(error.stderr || error.stdout || error.message);
  }
}

async function executeMySQLQuery(containerId, query) {
  try {
    const { stdout, stderr } = await execDockerWithInput(containerId, ['mysql', '-u', 'root', '--batch'], query, 30000);
    const output = stdout || stderr;

    // Check if there's an error in the output
    if (output.toLowerCase().includes('error') && !query.trim().toLowerCase().startsWith('select')) {
      throw new Error(output);
    }

    // Parse tabular output for SELECT queries
    if (query.trim().toLowerCase().startsWith('select')) {
      const lines = output.split('\n').filter(l => l.trim() && !l.toLowerCase().includes('error'));
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
    throw new Error(error.stderr || error.stdout || error.message);
  }
}

async function executeMongoCommand(containerId, command) {
  const authArgs = await getMongoAuthArgs(containerId);
  const commandVariants = [
    ['mongosh', '--quiet', ...authArgs],
    ['mongo', '--quiet', ...authArgs],
  ];

  for (const variant of commandVariants) {
    try {
      const { stdout, stderr } = await execDockerWithInput(containerId, variant, command, 30000);
      const output = (stdout || stderr).trim();

      // Check for errors
      if (output.toLowerCase().includes('error') && !output.includes('ObjectId')) {
        continue; // Try next shell
      }

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

function normalizeMongoRows(rows) {
  return rows.map(row => {
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
}

async function connectMongoUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return { error: 'MongoDB URI is required', tables: [], dbType: 'mongodb' };
  }

  try {
    const dbFromUri = extractMongoDbNameFromUri(uri.trim());
    const cmd = `
(() => {
  const preferredDb = ${JSON.stringify(dbFromUri || '')};
  if (preferredDb) {
    try {
      const preferred = db.getMongo().getDB(preferredDb).getCollectionNames();
      print(JSON.stringify(preferred.map((c) => preferredDb + '.' + c)));
      return;
    } catch (_) {
      // Continue to broader discovery
    }
  }
  try {
    const systemDbs = new Set(['admin', 'local', 'config']);
    const dbNames = db.getMongo().getDBNames().filter((name) => !systemDbs.has(name));
    const qualified = [];
    dbNames.forEach((dbName) => {
      const cols = db.getMongo().getDB(dbName).getCollectionNames();
      cols.forEach((col) => qualified.push(dbName + '.' + col));
    });
    if (qualified.length > 0) {
      print(JSON.stringify(qualified));
      return;
    }
  } catch (_) {
    // Fall back to current DB only
  }
  print(JSON.stringify(db.getCollectionNames()));
})();
`;
    const { stdout, stderr } = await execMongoUriEval(uri.trim(), cmd, 30000);
    const shellOutput = `${stdout || ''}\n${stderr || ''}`.trim();
    const shellError = detectMongoShellError(shellOutput);
    if (shellError) {
      return { error: shellError, tables: [], dbType: 'mongodb' };
    }
    let collections = [];

    try {
      const jsonPayload = extractJsonCandidate(stdout, '[]');
      const parsed = JSON.parse(jsonPayload);
      if (Array.isArray(parsed)) {
        collections = parsed
          .map((name) => String(name).trim())
          .filter(Boolean);
      }
    } catch {
      collections = parseMongoCollectionLines(stdout);
    }

    return { tables: collections, dbType: 'mongodb' };
  } catch (error) {
    return { error: error.message || 'Could not connect to MongoDB URI', tables: [], dbType: 'mongodb' };
  }
}

async function getMongoUriCollectionData(uri, collectionName, limit = 100) {
  if (!uri || !collectionName) {
    return { error: 'MongoDB URI and collection are required', columns: [], rows: [], dbType: 'mongodb' };
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Number(limit))) : 100;
  let dbName = '';
  let bareCollectionName = collectionName;
  const dotIndex = collectionName.indexOf('.');
  if (dotIndex > 0) {
    dbName = collectionName.slice(0, dotIndex);
    bareCollectionName = collectionName.slice(dotIndex + 1);
  }

  const safeDbName = dbName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeCollectionName = bareCollectionName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cmd = dbName
    ? `print(JSON.stringify(db.getMongo().getDB("${safeDbName}").getCollection("${safeCollectionName}").find().limit(${safeLimit}).toArray()))`
    : `print(JSON.stringify(db.getCollection("${safeCollectionName}").find().limit(${safeLimit}).toArray()))`;

  try {
    const { stdout } = await execMongoUriEval(uri.trim(), cmd, 30000);
    const jsonPayload = extractJsonCandidate(stdout, '[]');
    const rows = JSON.parse(jsonPayload);
    const cleanRows = Array.isArray(rows) ? normalizeMongoRows(rows) : [];
    const columnSet = new Set();
    cleanRows.slice(0, 20).forEach((row) => {
      Object.keys(row || {}).forEach((key) => columnSet.add(key));
    });
    const columns = Array.from(columnSet);
    return { columns, rows: cleanRows, dbType: 'mongodb', tableName: collectionName };
  } catch (error) {
    return { error: error.message || 'Could not query MongoDB URI collection', columns: [], rows: [], dbType: 'mongodb' };
  }
}

async function executeMongoUriQuery(uri, command) {
  if (!uri || !command || !command.trim()) {
    return { error: 'MongoDB URI and command are required', dbType: 'mongodb' };
  }

  try {
    const { stdout, stderr } = await execMongoUriEval(uri.trim(), command, 30000);
    const output = (stdout || stderr).trim();

    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        const cleanRows = normalizeMongoRows(parsed);
        const columns = cleanRows.length > 0 ? Object.keys(cleanRows[0]) : [];
        return { columns, rows: cleanRows, rowCount: cleanRows.length, dbType: 'mongodb' };
      }
      return { output: JSON.stringify(parsed, null, 2), dbType: 'mongodb' };
    } catch {
      return { output, dbType: 'mongodb' };
    }
  } catch (error) {
    return { error: error.message || 'Failed to execute MongoDB URI query', dbType: 'mongodb' };
  }
}

async function connectPostgresUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return { error: 'PostgreSQL URI is required', tables: [], dbType: 'postgresql' };
  }

  if (!isPostgresUri(uri)) {
    return { error: 'Invalid PostgreSQL URI', tables: [], dbType: 'postgresql' };
  }

  try {
    const tables = await withPostgresUriClient(uri.trim(), async (client) => {
      const result = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`
      );
      return result.rows.map((row) => String(row.table_name).trim()).filter(Boolean);
    });

    return { tables, dbType: 'postgresql' };
  } catch (error) {
    return { error: error.message || 'Could not connect to PostgreSQL URI', tables: [], dbType: 'postgresql' };
  }
}

async function getPostgresUriTableData(uri, tableName, limit = 100) {
  if (!uri || !tableName) {
    return { error: 'PostgreSQL URI and table name are required', columns: [], rows: [], dbType: 'postgresql' };
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Number(limit))) : 100;

  try {
    const safeTableName = sanitizePostgresIdentifier(tableName);
    const result = await withPostgresUriClient(uri.trim(), async (client) => {
      const columnsResult = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
         ORDER BY ordinal_position`,
        [safeTableName]
      );
      const dataResult = await client.query(`SELECT * FROM "${safeTableName}" LIMIT ${safeLimit}`);
      return {
        columns: columnsResult.rows.map((row) => row.column_name),
        rows: dataResult.rows || [],
      };
    });

    return { ...result, tableName: safeTableName, dbType: 'postgresql' };
  } catch (error) {
    return { error: error.message || 'Could not query PostgreSQL URI table', columns: [], rows: [], dbType: 'postgresql' };
  }
}

async function executePostgresUriQuery(uri, query) {
  if (!uri || !query || !query.trim()) {
    return { error: 'PostgreSQL URI and query are required', dbType: 'postgresql' };
  }

  try {
    const trimmed = query.trim();
    const result = await withPostgresUriClient(uri.trim(), async (client) => client.query(trimmed));

    if (Array.isArray(result.rows) && result.rows.length > 0) {
      const columns = Object.keys(result.rows[0]);
      return {
        columns,
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
        dbType: 'postgresql',
      };
    }

    return {
      output: typeof result.rowCount === 'number' ? `${result.command || 'QUERY'} ${result.rowCount}` : (result.command || 'Query executed'),
      rowCount: result.rowCount ?? 0,
      columns: [],
      rows: [],
      dbType: 'postgresql',
    };
  } catch (error) {
    return { error: error.message || 'Failed to execute PostgreSQL URI query', dbType: 'postgresql' };
  }
}

/**
 * Create a new table in the database
 * @param {string} containerId - Docker container ID
 * @param {string} containerImage - Container image name
 * @param {string} tableName - Name of the table to create
 * @param {Array} columns - Array of column definitions {name, type, constraints}
 * @returns {Promise<Object>} Result of the operation
 */
async function createTable(containerId, containerImage, tableName, columns) {
  const dbType = detectDatabaseType(containerImage);
  if (!dbType) {
    return { error: 'Unsupported database type', success: false };
  }

  // Sanitize table name
  const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeTableName || safeTableName.length === 0) {
    return { error: 'Invalid table name', success: false };
  }

  try {
    switch (dbType) {
      case 'postgresql':
        return await createPostgresTable(containerId, safeTableName, columns);
      case 'mysql':
        return await createMySQLTable(containerId, safeTableName, columns);
      case 'mongodb':
        return await createMongoCollection(containerId, safeTableName, columns);
      default:
        return { error: 'Unsupported database type', success: false };
    }
  } catch (error) {
    return { error: error.message, success: false };
  }
}

async function createPostgresTable(containerId, tableName, columns) {
  if (!columns || columns.length === 0) {
    return { error: 'At least one column is required', success: false };
  }

  // Build column definitions
  const columnDefs = columns.map(col => {
    const safeName = col.name.replace(/[^a-zA-Z0-9_]/g, '');
    let def = `${safeName} ${col.type}`;

    if (col.primaryKey) def += ' PRIMARY KEY';
    if (col.notNull && !col.primaryKey) def += ' NOT NULL';
    if (col.unique && !col.primaryKey) def += ' UNIQUE';
    if (col.defaultValue !== undefined && col.defaultValue !== '') {
      // Handle different default value types
      if (col.type.toLowerCase().includes('serial') || col.type.toLowerCase().includes('auto_increment')) {
        // Skip default for auto-increment columns
      } else if (col.type.toLowerCase().includes('int') || col.type.toLowerCase().includes('numeric') || col.type.toLowerCase().includes('decimal')) {
        def += ` DEFAULT ${col.defaultValue}`;
      } else {
        def += ` DEFAULT '${col.defaultValue.replace(/'/g, "''")}'`;
      }
    }

    return def;
  }).join(', ');

  const query = `CREATE TABLE ${tableName} (${columnDefs});`;
  const result = await executePostgresQuery(containerId, query);

  if (result.error) {
    throw new Error(result.error);
  }

  return { success: true, message: `Table '${tableName}' created successfully`, query };
}

async function createMySQLTable(containerId, tableName, columns) {
  if (!columns || columns.length === 0) {
    return { error: 'At least one column is required', success: false };
  }

  // Build column definitions
  const columnDefs = columns.map(col => {
    const safeName = col.name.replace(/[^a-zA-Z0-9_]/g, '');
    let def = `${safeName} ${col.type}`;

    if (col.notNull || col.primaryKey) def += ' NOT NULL';
    if (col.type.toLowerCase().includes('auto_increment')) {
      def += ' AUTO_INCREMENT';
    }
    if (col.defaultValue !== undefined && col.defaultValue !== '' && !col.type.toLowerCase().includes('auto_increment')) {
      if (col.type.toLowerCase().includes('int') || col.type.toLowerCase().includes('numeric') || col.type.toLowerCase().includes('decimal')) {
        def += ` DEFAULT ${col.defaultValue}`;
      } else {
        def += ` DEFAULT '${col.defaultValue.replace(/'/g, "''")}'`;
      }
    }

    return def;
  }).join(', ');

  // Find primary key column
  const primaryKeyCol = columns.find(col => col.primaryKey);
  const primaryKeyDef = primaryKeyCol ? `, PRIMARY KEY (${primaryKeyCol.name.replace(/[^a-zA-Z0-9_]/g, '')})` : '';

  const query = `CREATE TABLE ${tableName} (${columnDefs}${primaryKeyDef});`;
  const result = await executeMySQLQuery(containerId, query);

  if (result.error) {
    throw new Error(result.error);
  }

  return { success: true, message: `Table '${tableName}' created successfully`, query };
}

async function createMongoCollection(containerId, collectionName, columns) {
  // MongoDB doesn't require schema, so we just create the collection
  // If columns are provided, we can create a sample document or validation schema

  const commands = [
    `db.createCollection('${collectionName}')`,
    `db.createCollection("${collectionName}")`
  ];

  for (const command of commands) {
    try {
      const result = await executeMongoCommand(containerId, command);
      if (!result.error) {
        return {
          success: true,
          message: `Collection '${collectionName}' created successfully`,
          note: 'MongoDB is schemaless - documents can have any structure'
        };
      }
    } catch {
      continue;
    }
  }

  throw new Error('Could not create MongoDB collection');
}

module.exports = {
  detectDatabaseType,
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
};
