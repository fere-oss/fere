const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
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
const PG_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MONGO_FIND_RE = /\.find\s*\(/;
const MONGO_LIMIT_RE = /\.limit\s*\(/;
const MONGO_TOARRAY_RE = /\.toArray\s*\(/;
const MYSQL_SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const dbTypeCache = new Map();

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
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
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
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
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

    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate to SIGKILL if SIGTERM doesn't work after 2s
      killTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
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
  if (!PG_IDENTIFIER_RE.test(value)) {
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
  let result = dbTypeCache.get(image);
  if (result !== undefined) return result;
  const imageLower = image.toLowerCase();
  if (imageLower.includes('postgres') || imageLower.includes('pg')) result = 'postgresql';
  else if (imageLower.includes('mysql') || imageLower.includes('mariadb')) result = 'mysql';
  else if (imageLower.includes('mongo')) result = 'mongodb';
  else result = null;
  dbTypeCache.set(image, result);
  return result;
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

// Detect the PostgreSQL user from container env vars, falling back to common defaults
async function resolvePostgresUser(containerId) {
  try {
    const { stdout } = await execDocker(containerId, ['env'], 5000);
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1).trim();
      if ((key === 'POSTGRES_USER' || key === 'PGUSER') && val) return val;
    }
  } catch {
    // ignore
  }
  return null;
}

// PostgreSQL functions
async function getPostgresTables(containerId) {
  const sql = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;";

  // Try env-detected user first, then 'postgres', then no user flag
  const envUser = await resolvePostgresUser(containerId);
  const userCandidates = [
    ...(envUser ? [envUser] : []),
    'postgres',
    null, // let psql use its default
  ];

  let lastError;
  for (const user of userCandidates) {
    try {
      const args = user
        ? ['psql', '-U', user, '-t', '-c', sql]
        : ['psql', '-t', '-c', sql];
      const { stdout } = await execDocker(containerId, args, 10000);
      const tables = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      return { tables, dbType: 'postgresql' };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Escape a PostgreSQL identifier with double-quote wrapping (handles hyphens, dots, etc.)
function escapePostgresIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// Escape a PostgreSQL string literal (for use inside single quotes)
function escapePostgresLiteral(name) {
  return String(name).replace(/'/g, "''");
}

async function getPostgresTableData(containerId, tableName, limit) {
  // Use parameterized literal for the information_schema lookup
  // and quoted identifier for the SELECT
  const safeIdent = escapePostgresIdent(tableName);
  const safeLiteral = escapePostgresLiteral(tableName);

  // Resolve the PostgreSQL user the same way getPostgresTables does
  const envUser = await resolvePostgresUser(containerId);
  const userArgs = envUser ? ['-U', envUser] : ['-U', 'postgres'];

  // Get columns first
  const { stdout: colOut } = await execDocker(containerId, [
    'psql', ...userArgs, '-t', '-c',
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${safeLiteral}' ORDER BY ordinal_position;`
  ], 10000);
  const columns = colOut
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Get data as JSON
  const { stdout: dataOut } = await execDocker(containerId, [
    'psql', ...userArgs, '-t', '-c',
    `SELECT row_to_json(t) FROM (SELECT * FROM ${safeIdent} LIMIT ${limit}) t;`
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

  return { columns, rows, dbType: 'postgresql', tableName };
}

// MySQL functions
async function getMySQLTables(containerId) {
  const authArgs = await resolveMySQLAuth(containerId);
  try {
    const { stdout } = await execDocker(containerId, ['mysql', ...authArgs, '-e', 'SHOW TABLES;', '--skip-column-names'], 10000);
    const tables = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return { tables, dbType: 'mysql' };
  } catch (error) {
    // Try to find the database name first
    try {
      const { stdout: dbOut } = await execDocker(containerId, ['mysql', ...authArgs, '-e', 'SHOW DATABASES;', '--skip-column-names'], 10000);
      const databases = dbOut.split('\n').map(l => l.trim()).filter(l => l && !MYSQL_SYSTEM_DBS.has(l));

      if (databases.length > 0) {
        const { stdout } = await execDocker(containerId, ['mysql', ...authArgs, '-D', databases[0], '-e', 'SHOW TABLES;', '--skip-column-names'], 10000);
        const tables = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        return { tables, dbType: 'mysql', database: databases[0] };
      }
    } catch {
      throw error;
    }
    throw error;
  }
}

// Escape a MySQL identifier with backtick wrapping
function escapeMySQLIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

async function getMySQLTableData(containerId, tableName, limit) {
  const safeIdent = escapeMySQLIdent(tableName);
  const authArgs = await resolveMySQLAuth(containerId);

  // Get columns
  const { stdout: colOut } = await execDocker(containerId, [
    'mysql', ...authArgs, '-e', `DESCRIBE ${safeIdent};`, '--skip-column-names'
  ], 10000);
  const columns = colOut
    .split('\n')
    .map(line => line.split('\t')[0]?.trim())
    .filter(col => col && col.length > 0);

  // Get data as JSON
  const { stdout: dataOut } = await execDocker(containerId, [
    'mysql', ...authArgs, '-e', `SELECT * FROM ${safeIdent} LIMIT ${limit};`, '--batch'
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

  return { columns: headers, rows, dbType: 'mysql', tableName };
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

// MySQL auth helper — extract credentials from container environment variables
async function resolveMySQLAuth(containerId) {
  try {
    const { stdout } = await execDocker(containerId, ['env'], 5000);
    const env = {};
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    const user = env.MYSQL_USER || 'root';
    const pass = env.MYSQL_ROOT_PASSWORD || env.MYSQL_PASSWORD || '';
    if (pass) {
      return ['-u', user, `-p${pass}`];
    }
    return ['-u', user];
  } catch {
    return ['-u', 'root'];
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

// Escape a string for use inside a JavaScript double-quoted string in mongosh --eval
function escapeMongoJsString(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function getMongoCollectionData(containerId, collectionName, limit) {
  // Use getCollection("name") instead of db.name to handle special chars (hyphens, dots, etc.)
  const safeName = escapeMongoJsString(collectionName);
  const authArgs = await getMongoAuthArgs(containerId);

  const commandVariants = [
    ['mongosh', '--quiet', ...authArgs, '--eval', `JSON.stringify(db.getCollection("${safeName}").find().limit(${limit}).toArray())`],
    ['mongo', '--quiet', ...authArgs, '--eval', `JSON.stringify(db.getCollection("${safeName}").find().limit(${limit}).toArray())`],
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

      return { columns, rows: cleanRows, dbType: 'mongodb', tableName: collectionName };
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
    const envUser = await resolvePostgresUser(containerId);
    const userArgs = envUser ? ['-U', envUser] : ['-U', 'postgres'];
    const { stdout, stderr } = await execDockerWithInput(containerId, ['psql', ...userArgs], query, 30000);
    const output = stdout || stderr;

    // Check if there's an error in the output
    if (output.toLowerCase().includes('error:') || output.toLowerCase().includes('fatal:')) {
      throw new Error(output);
    }

    // Check if it's a SELECT query - try to parse as JSON
    if (query.trim().toLowerCase().startsWith('select')) {
      const jsonQuery = `SELECT json_agg(t) FROM (${query}) t;`;
      try {
        const { stdout: jsonOut } = await execDockerWithInput(containerId, ['psql', ...userArgs, '-t'], jsonQuery, 30000);
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
    const authArgs = await resolveMySQLAuth(containerId);
    const { stdout, stderr } = await execDockerWithInput(containerId, ['mysql', ...authArgs, '--batch'], query, 30000);
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

  // Safety: inject a default limit on .find() calls without one
  let safeCommand = command;
  const MAX_QUERY_ROWS = 1000;
  if (MONGO_FIND_RE.test(safeCommand) && !MONGO_LIMIT_RE.test(safeCommand)) {
    if (MONGO_TOARRAY_RE.test(safeCommand)) {
      safeCommand = safeCommand.replace(MONGO_TOARRAY_RE, `.limit(${MAX_QUERY_ROWS}).toArray(`);
    } else {
      safeCommand = safeCommand.replace(/(\.find\s*\([^)]*\))/, `$1.limit(${MAX_QUERY_ROWS})`);
    }
  }

  for (const variant of commandVariants) {
    try {
      const { stdout, stderr } = await execDockerWithInput(containerId, variant, safeCommand, 30000);
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
    // Safety: inject a default limit on .find() calls that don't already have one
    // to prevent unbounded result sets from crashing the app.
    let safeCommand = command;
    const MAX_QUERY_ROWS = 1000;
    if (MONGO_FIND_RE.test(safeCommand) && !MONGO_LIMIT_RE.test(safeCommand)) {
      // Insert .limit() before .toArray() if present, otherwise append it
      if (MONGO_TOARRAY_RE.test(safeCommand)) {
        safeCommand = safeCommand.replace(MONGO_TOARRAY_RE, `.limit(${MAX_QUERY_ROWS}).toArray(`);
      } else {
        safeCommand = safeCommand.replace(/(\.find\s*\([^)]*\))/, `$1.limit(${MAX_QUERY_ROWS})`);
      }
    }

    const { stdout, stderr } = await execMongoUriEval(uri.trim(), safeCommand, 30000);
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

// ============================================
// Elasticsearch URI Mode
// ============================================

function sanitizeEsBaseUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Try an ES request; if the URL is http:// and it fails, retry with https://
 * (Elasticsearch 8.x defaults to HTTPS with self-signed certs).
 */
async function esFetchWithFallback(url, options = {}) {
  try {
    return await esFetch(url, options);
  } catch (httpErr) {
    if (url.startsWith('http://')) {
      const httpsUrl = url.replace(/^http:\/\//, 'https://');
      try {
        return await esFetch(httpsUrl, options);
      } catch {
        throw httpErr;
      }
    }
    throw httpErr;
  }
}

/**
 * HTTP(S) request helper for Elasticsearch.
 * Uses Node http/https modules directly so we can accept self-signed certs
 * (Elasticsearch 8.x defaults to HTTPS with a self-signed certificate).
 */
function esFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 9200),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      // Accept self-signed certs for local ES instances
      ...(isHttps ? { rejectUnauthorized: false } : {}),
      timeout: 10000,
    };
    // Forward basic auth from URL if present
    if (parsed.username) {
      reqOptions.auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`;
    }

    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          let message = `Elasticsearch returned ${res.statusCode}`;
          try { message = JSON.parse(body)?.error?.reason || message; } catch {}
          reject(new Error(message));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON response from Elasticsearch`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Connect to an Elasticsearch instance via HTTP URL and list indices.
 * @param {string} baseUrl - e.g. "http://localhost:9200"
 * @returns {Promise<Object>} { tables, dbType, error? }
 */
async function connectElasticsearchUri(baseUrl) {
  try {
    const url = sanitizeEsBaseUrl(baseUrl);

    // Verify this is actually Elasticsearch (auto-fallback HTTP → HTTPS)
    const root = await esFetchWithFallback(url);
    if (!root.tagline || !root.tagline.includes('You Know, for Search')) {
      return { error: 'URL does not appear to be an Elasticsearch instance', tables: [] };
    }

    // List indices (exclude system indices starting with ".")
    const indices = await esFetchWithFallback(`${url}/_cat/indices?format=json&h=index,health,status,docs.count,store.size`);
    const tables = (Array.isArray(indices) ? indices : [])
      .filter(idx => idx.index && !idx.index.startsWith('.'))
      .map(idx => idx.index)
      .sort();

    return { tables, dbType: 'elasticsearch', database: root.cluster_name || 'elasticsearch' };
  } catch (error) {
    return { error: error.message || 'Failed to connect to Elasticsearch', tables: [] };
  }
}

/**
 * Fetch documents from an Elasticsearch index.
 * @param {string} baseUrl - e.g. "http://localhost:9200"
 * @param {string} indexName - Index name
 * @param {number} limit - Max documents to return
 * @returns {Promise<Object>} { columns, rows, dbType, error? }
 */
async function getElasticsearchUriIndexData(baseUrl, indexName, limit = 100) {
  try {
    const url = sanitizeEsBaseUrl(baseUrl);
    const safeName = encodeURIComponent(indexName);
    const result = await esFetchWithFallback(`${url}/${safeName}/_search?size=${limit}`);

    const hits = result.hits?.hits || [];
    if (hits.length === 0) {
      return { columns: ['_id'], rows: [], dbType: 'elasticsearch', tableName: indexName };
    }

    // Collect all unique field names across documents
    const columnSet = new Set(['_id']);
    for (const hit of hits) {
      if (hit._source) {
        for (const key of Object.keys(hit._source)) columnSet.add(key);
      }
    }
    const columns = Array.from(columnSet);

    const rows = hits.map(hit => ({
      _id: hit._id,
      ...hit._source,
    }));

    return { columns, rows, dbType: 'elasticsearch', tableName: indexName };
  } catch (error) {
    return { columns: [], rows: [], error: error.message || 'Failed to fetch index data', dbType: 'elasticsearch' };
  }
}

/**
 * Execute a search query against Elasticsearch.
 * @param {string} baseUrl - e.g. "http://localhost:9200"
 * @param {string} query - JSON search DSL body
 * @returns {Promise<Object>} { columns, rows, rowCount, dbType, error? }
 */
async function executeElasticsearchUriQuery(baseUrl, query) {
  try {
    const url = sanitizeEsBaseUrl(baseUrl);

    let body;
    try {
      body = JSON.parse(query);
    } catch {
      return { error: 'Query must be valid JSON. Example: {"query": {"match_all": {}}}', dbType: 'elasticsearch' };
    }

    const result = await esFetchWithFallback(`${url}/_search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const hits = result.hits?.hits || [];
    if (hits.length === 0) {
      return {
        columns: ['_id'],
        rows: [],
        rowCount: result.hits?.total?.value ?? 0,
        dbType: 'elasticsearch',
      };
    }

    const columnSet = new Set(['_id']);
    for (const hit of hits) {
      if (hit._source) {
        for (const key of Object.keys(hit._source)) columnSet.add(key);
      }
    }

    return {
      columns: Array.from(columnSet),
      rows: hits.map(hit => ({ _id: hit._id, ...hit._source })),
      rowCount: result.hits?.total?.value ?? hits.length,
      dbType: 'elasticsearch',
    };
  } catch (error) {
    return { error: error.message || 'Failed to execute Elasticsearch query', dbType: 'elasticsearch' };
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

  // Validate table name is non-empty (quoting handles special chars)
  const trimmedTableName = (tableName || '').trim();
  if (!trimmedTableName) {
    return { error: 'Invalid table name', success: false };
  }

  try {
    switch (dbType) {
      case 'postgresql':
        return await createPostgresTable(containerId, trimmedTableName, columns);
      case 'mysql':
        return await createMySQLTable(containerId, trimmedTableName, columns);
      case 'mongodb':
        return await createMongoCollection(containerId, trimmedTableName, columns);
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

  // Build column definitions using proper identifier quoting
  const columnDefs = columns.map(col => {
    const safeName = escapePostgresIdent(col.name);
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

  const query = `CREATE TABLE ${escapePostgresIdent(tableName)} (${columnDefs});`;
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

  // Build column definitions using proper identifier quoting
  const columnDefs = columns.map(col => {
    const safeName = escapeMySQLIdent(col.name);
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
  const primaryKeyDef = primaryKeyCol ? `, PRIMARY KEY (${escapeMySQLIdent(primaryKeyCol.name)})` : '';

  const query = `CREATE TABLE ${escapeMySQLIdent(tableName)} (${columnDefs}${primaryKeyDef});`;
  const result = await executeMySQLQuery(containerId, query);

  if (result.error) {
    throw new Error(result.error);
  }

  return { success: true, message: `Table '${tableName}' created successfully`, query };
}

async function createMongoCollection(containerId, collectionName, columns) {
  // MongoDB doesn't require schema, so we just create the collection
  // If columns are provided, we can create a sample document or validation schema

  const safeName = escapeMongoJsString(collectionName);
  const commands = [
    `db.createCollection("${safeName}")`,
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
  connectElasticsearchUri,
  getElasticsearchUriIndexData,
  executeElasticsearchUriQuery,
};
