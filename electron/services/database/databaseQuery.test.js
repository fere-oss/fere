const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectDatabaseType,
  extractJsonCandidate,
  stripMongoShellNoise,
  parseMongoCollectionLines,
  extractMongoDbNameFromUri,
  detectMongoShellError,
  isPostgresUri,
  sanitizePostgresIdentifier,
  escapePostgresIdent,
  escapePostgresLiteral,
  sanitizeEsBaseUrl,
  validateContainerId,
} = require("./databaseQuery");

// ─── detectDatabaseType ───────────────────────────────────────────────────────

test("detectDatabaseType: identifies postgres images", () => {
  assert.equal(detectDatabaseType("postgres:15"), "postgresql");
  assert.equal(detectDatabaseType("postgres:latest"), "postgresql");
  assert.equal(detectDatabaseType("timescale/timescaledb:latest-pg14"), "postgresql");
  assert.equal(detectDatabaseType("bitnami/postgresql:15"), "postgresql");
});

test("detectDatabaseType: identifies pg shorthand images", () => {
  assert.equal(detectDatabaseType("pgvector/pgvector:pg16"), "postgresql");
});

test("detectDatabaseType: identifies mysql and mariadb images", () => {
  assert.equal(detectDatabaseType("mysql:8.0"), "mysql");
  assert.equal(detectDatabaseType("mysql:latest"), "mysql");
  assert.equal(detectDatabaseType("mariadb:11"), "mysql");
  assert.equal(detectDatabaseType("bitnami/mariadb:latest"), "mysql");
});

test("detectDatabaseType: identifies mongo images", () => {
  assert.equal(detectDatabaseType("mongo:6.0"), "mongodb");
  assert.equal(detectDatabaseType("mongo:latest"), "mongodb");
  assert.equal(detectDatabaseType("mongodb/mongodb-community-server:latest"), "mongodb");
});

test("detectDatabaseType: returns null for unsupported images", () => {
  assert.equal(detectDatabaseType("nginx:latest"), null);
  assert.equal(detectDatabaseType("redis:7"), null);
  assert.equal(detectDatabaseType("node:20"), null);
  assert.equal(detectDatabaseType(""), null);
});

test("detectDatabaseType: is case-insensitive", () => {
  assert.equal(detectDatabaseType("Postgres:15"), "postgresql");
  assert.equal(detectDatabaseType("MySQL:8"), "mysql");
  assert.equal(detectDatabaseType("Mongo:6"), "mongodb");
});

// ─── validateContainerId ─────────────────────────────────────────────────────

test("validateContainerId: accepts valid container IDs", () => {
  assert.doesNotThrow(() => validateContainerId("abc123"));
  assert.doesNotThrow(() => validateContainerId("my-container"));
  assert.doesNotThrow(() => validateContainerId("my_container.1"));
});

test("validateContainerId: rejects invalid IDs", () => {
  assert.throws(() => validateContainerId(""), /Invalid container ID/);
  assert.throws(() => validateContainerId(null), /Invalid container ID/);
  assert.throws(() => validateContainerId("../etc/passwd"), /Invalid container ID/);
  assert.throws(() => validateContainerId("foo; rm -rf /"), /Invalid container ID/);
  assert.throws(() => validateContainerId("foo`bar`"), /Invalid container ID/);
});

// ─── extractJsonCandidate ─────────────────────────────────────────────────────

test("extractJsonCandidate: returns last JSON array line", () => {
  const output = 'mongosh 2.0\nConnecting...\n[{"a":1},{"b":2}]';
  assert.equal(extractJsonCandidate(output), '[{"a":1},{"b":2}]');
});

test("extractJsonCandidate: returns last JSON object line", () => {
  const output = 'some noise\n{"key":"value"}';
  assert.equal(extractJsonCandidate(output), '{"key":"value"}');
});

test("extractJsonCandidate: returns fallback when no JSON found", () => {
  assert.equal(extractJsonCandidate("no json here", "[]"), "[]");
  assert.equal(extractJsonCandidate("", "fallback"), "fallback");
  assert.equal(extractJsonCandidate(null), "[]");
});

test("extractJsonCandidate: picks last JSON line over earlier ones", () => {
  const output = "[1,2,3]\nsome text\n[4,5,6]";
  assert.equal(extractJsonCandidate(output), "[4,5,6]");
});

// ─── stripMongoShellNoise ─────────────────────────────────────────────────────

test("stripMongoShellNoise: removes shell prompt lines", () => {
  const input = 'test> \ntest> ...\n{"result": 1}';
  const result = stripMongoShellNoise(input);
  assert.ok(!result.includes("test>"));
  assert.ok(result.includes('{"result": 1}'));
});

test("stripMongoShellNoise: removes dots-only lines", () => {
  const input = '...\n... \n{"ok": 1}';
  const result = stripMongoShellNoise(input);
  assert.equal(result, '{"ok": 1}');
});

test("stripMongoShellNoise: strips prompt prefix from data lines", () => {
  const input = 'mydb> {"value": 42}';
  const result = stripMongoShellNoise(input);
  assert.equal(result, '{"value": 42}');
});

test("stripMongoShellNoise: handles empty/null input", () => {
  assert.equal(stripMongoShellNoise(""), "");
  assert.equal(stripMongoShellNoise(null), "");
});

// ─── parseMongoCollectionLines ────────────────────────────────────────────────

test("parseMongoCollectionLines: filters atlas/shell banner lines", () => {
  const input = [
    "Atlas atlas-xyz> ",
    "Connecting to: mongodb+srv://...",
    "Using MongoDB: 7.0.0",
    "For mongosh info see: https://docs.mongodb.com",
    "Current Mongosh Log ID: abc123",
    "To help improve our products",
    "users",
    "orders",
    "products",
  ].join("\n");

  const result = parseMongoCollectionLines(input);
  assert.deepEqual(result, ["users", "orders", "products"]);
});

test("parseMongoCollectionLines: keeps plain collection names", () => {
  const result = parseMongoCollectionLines("users\norders\n");
  assert.deepEqual(result, ["users", "orders"]);
});

test("parseMongoCollectionLines: handles empty input", () => {
  assert.deepEqual(parseMongoCollectionLines(""), []);
  assert.deepEqual(parseMongoCollectionLines(null), []);
});

// ─── extractMongoDbNameFromUri ────────────────────────────────────────────────

test("extractMongoDbNameFromUri: extracts db name from standard URI", () => {
  assert.equal(extractMongoDbNameFromUri("mongodb://localhost:27017/mydb"), "mydb");
  assert.equal(extractMongoDbNameFromUri("mongodb://user:pass@host/testdb"), "testdb");
});

test("extractMongoDbNameFromUri: extracts from mongodb+srv URIs", () => {
  assert.equal(
    extractMongoDbNameFromUri("mongodb+srv://cluster.mongodb.net/production"),
    "production",
  );
});

test("extractMongoDbNameFromUri: strips query params", () => {
  const result = extractMongoDbNameFromUri("mongodb://host/mydb?authSource=admin");
  assert.equal(result, "mydb");
});

test("extractMongoDbNameFromUri: returns null when no db path", () => {
  assert.equal(extractMongoDbNameFromUri("mongodb://localhost:27017/"), null);
  assert.equal(extractMongoDbNameFromUri("mongodb://localhost:27017"), null);
  assert.equal(extractMongoDbNameFromUri(""), null);
});

// ─── detectMongoShellError ────────────────────────────────────────────────────

test("detectMongoShellError: detects authentication errors", () => {
  // 'authentication failed' is checked first
  assert.ok(detectMongoShellError("Error: Authentication failed").includes("authentication"));
  // 'bad auth' without a MongoServerError prefix
  assert.ok(detectMongoShellError("bad auth : command failed").includes("authentication"));
  assert.ok(detectMongoShellError("not authorized on admin").includes("authorized"));
});

test("detectMongoShellError: detects generic server errors", () => {
  // 'mongoservererror' prefix returns the generic server error message
  const result = detectMongoShellError("MongoServerError: something went wrong");
  assert.ok(result !== null);
  assert.ok(result.toLowerCase().includes("error"));
});

test("detectMongoShellError: returns null for clean output", () => {
  assert.equal(detectMongoShellError(""), null);
  assert.equal(detectMongoShellError('["users","orders"]'), null);
  assert.equal(detectMongoShellError(null), null);
});

// ─── isPostgresUri ────────────────────────────────────────────────────────────

test("isPostgresUri: recognises postgres:// and postgresql:// schemes", () => {
  assert.ok(isPostgresUri("postgres://user:pass@host/db"));
  assert.ok(isPostgresUri("postgresql://localhost:5432/mydb"));
  assert.ok(isPostgresUri("POSTGRES://host/db")); // case-insensitive
});

test("isPostgresUri: rejects non-postgres URIs", () => {
  assert.ok(!isPostgresUri("mongodb://host/db"));
  assert.ok(!isPostgresUri("mysql://host/db"));
  assert.ok(!isPostgresUri(""));
  assert.ok(!isPostgresUri(null));
});

// ─── sanitizePostgresIdentifier ───────────────────────────────────────────────

test("sanitizePostgresIdentifier: accepts valid identifiers", () => {
  assert.equal(sanitizePostgresIdentifier("users"), "users");
  assert.equal(sanitizePostgresIdentifier("my_table"), "my_table");
  assert.equal(sanitizePostgresIdentifier("Table2"), "Table2");
});

test("sanitizePostgresIdentifier: rejects identifiers with special chars", () => {
  assert.throws(() => sanitizePostgresIdentifier("users; DROP TABLE users"), /Invalid/);
  assert.throws(() => sanitizePostgresIdentifier("1invalid"), /Invalid/);
  assert.throws(() => sanitizePostgresIdentifier("my-table"), /Invalid/);
  assert.throws(() => sanitizePostgresIdentifier(""), /Invalid/);
});

// ─── escapePostgresIdent ──────────────────────────────────────────────────────

test("escapePostgresIdent: wraps in double quotes", () => {
  assert.equal(escapePostgresIdent("users"), '"users"');
  assert.equal(escapePostgresIdent("my table"), '"my table"');
});

test("escapePostgresIdent: escapes internal double quotes", () => {
  assert.equal(escapePostgresIdent('say "hi"'), '"say ""hi"""');
});

// ─── escapePostgresLiteral ────────────────────────────────────────────────────

test("escapePostgresLiteral: escapes single quotes", () => {
  assert.equal(escapePostgresLiteral("O'Brien"), "O''Brien");
  assert.equal(escapePostgresLiteral("it's fine"), "it''s fine");
});

test("escapePostgresLiteral: leaves clean strings untouched", () => {
  assert.equal(escapePostgresLiteral("hello"), "hello");
});

// ─── sanitizeEsBaseUrl ────────────────────────────────────────────────────────

test("sanitizeEsBaseUrl: strips trailing slashes", () => {
  assert.equal(sanitizeEsBaseUrl("http://localhost:9200/"), "http://localhost:9200");
  assert.equal(sanitizeEsBaseUrl("http://localhost:9200///"), "http://localhost:9200");
});

test("sanitizeEsBaseUrl: trims whitespace", () => {
  assert.equal(sanitizeEsBaseUrl("  http://localhost:9200  "), "http://localhost:9200");
});

test("sanitizeEsBaseUrl: leaves clean URLs untouched", () => {
  assert.equal(sanitizeEsBaseUrl("http://localhost:9200"), "http://localhost:9200");
  assert.equal(sanitizeEsBaseUrl("https://es.example.com:9243"), "https://es.example.com:9243");
});
