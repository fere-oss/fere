const test = require('node:test');
const assert = require('node:assert/strict');

const {
  redactEntry,
  redactObject,
  redactFormEncoded,
  looksLikeFormEncoded,
  SENSITIVE_HEADERS,
  SENSITIVE_BODY_FIELDS,
} = require('./requestHistory');

// ============================================
// redactObject — plain objects
// ============================================

test('redactObject redacts sensitive keys (case-insensitive)', () => {
  const obj = { Password: 'hunter2', username: 'alice' };
  const result = redactObject(obj, SENSITIVE_BODY_FIELDS);
  assert.equal(result.Password, '[REDACTED]');
  assert.equal(result.username, 'alice');
});

test('redactObject recurses into nested objects', () => {
  const obj = { user: { credentials: 'abc123', name: 'bob' } };
  const result = redactObject(obj, SENSITIVE_BODY_FIELDS);
  assert.equal(result.user.credentials, '[REDACTED]');
  assert.equal(result.user.name, 'bob');
});

test('redactObject does not mutate the original', () => {
  const obj = { token: 'secret', safe: 'ok' };
  const original = JSON.parse(JSON.stringify(obj));
  redactObject(obj, SENSITIVE_BODY_FIELDS);
  assert.deepEqual(obj, original);
});

// ============================================
// redactObject — arrays
// ============================================

test('redactObject recurses into arrays of objects', () => {
  const arr = [
    { password: 'p1', user: 'a' },
    { password: 'p2', user: 'b' },
  ];
  const result = redactObject(arr, SENSITIVE_BODY_FIELDS);
  assert.equal(result[0].password, '[REDACTED]');
  assert.equal(result[0].user, 'a');
  assert.equal(result[1].password, '[REDACTED]');
  assert.equal(result[1].user, 'b');
});

test('redactObject handles nested arrays', () => {
  const obj = { users: [{ api_key: 'k1' }, { api_key: 'k2' }] };
  const result = redactObject(obj, SENSITIVE_BODY_FIELDS);
  assert.equal(result.users[0].api_key, '[REDACTED]');
  assert.equal(result.users[1].api_key, '[REDACTED]');
});

test('redactObject passes through arrays of primitives', () => {
  const obj = { tags: ['a', 'b', 'c'] };
  const result = redactObject(obj, SENSITIVE_BODY_FIELDS);
  assert.deepEqual(result.tags, ['a', 'b', 'c']);
});

// ============================================
// looksLikeFormEncoded
// ============================================

test('looksLikeFormEncoded detects simple form data', () => {
  assert.equal(looksLikeFormEncoded('user=alice&password=secret'), true);
});

test('looksLikeFormEncoded detects single pair', () => {
  assert.equal(looksLikeFormEncoded('token=abc123'), true);
});

test('looksLikeFormEncoded rejects plain text', () => {
  assert.equal(looksLikeFormEncoded('just some plain text'), false);
});

test('looksLikeFormEncoded rejects JSON', () => {
  assert.equal(looksLikeFormEncoded('{"key": "value"}'), false);
});

test('looksLikeFormEncoded rejects empty string', () => {
  assert.equal(looksLikeFormEncoded(''), false);
});

// ============================================
// redactFormEncoded
// ============================================

test('redactFormEncoded redacts sensitive keys in form data', () => {
  const input = 'username=alice&password=hunter2&remember=true';
  const result = redactFormEncoded(input);
  assert.equal(result, 'username=alice&password=[REDACTED]&remember=true');
});

test('redactFormEncoded redacts multiple sensitive keys', () => {
  const input = 'token=abc&api_key=xyz&name=test';
  const result = redactFormEncoded(input);
  assert.equal(result, 'token=[REDACTED]&api_key=[REDACTED]&name=test');
});

test('redactFormEncoded is case-insensitive', () => {
  const input = 'PASSWORD=secret&user=bob';
  const result = redactFormEncoded(input);
  assert.equal(result, 'PASSWORD=[REDACTED]&user=bob');
});

test('redactFormEncoded handles sensitive key at start', () => {
  const input = 'secret=mysecret&other=value';
  const result = redactFormEncoded(input);
  assert.equal(result, 'secret=[REDACTED]&other=value');
});

test('redactFormEncoded handles sensitive key at end', () => {
  const input = 'user=bob&client_secret=shh';
  const result = redactFormEncoded(input);
  assert.equal(result, 'user=bob&client_secret=[REDACTED]');
});

test('redactFormEncoded handles URL-encoded values', () => {
  const input = 'password=my%20secret%21&user=alice';
  const result = redactFormEncoded(input);
  assert.equal(result, 'password=[REDACTED]&user=alice');
});

// ============================================
// redactEntry — full integration
// ============================================

test('redactEntry redacts sensitive headers', () => {
  const entry = {
    id: '1',
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://localhost:3000/api',
    headers: {
      'Authorization': 'Bearer token123',
      'Content-Type': 'application/json',
      'X-API-Key': 'key456',
    },
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const result = redactEntry(entry);
  assert.equal(result.headers['Authorization'], '[REDACTED]');
  assert.equal(result.headers['X-API-Key'], '[REDACTED]');
  assert.equal(result.headers['Content-Type'], 'application/json');
});

test('redactEntry redacts JSON body fields', () => {
  const entry = {
    id: '2',
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://localhost:3000/login',
    headers: {},
    body: JSON.stringify({ username: 'alice', password: 'secret123' }),
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const result = redactEntry(entry);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.username, 'alice');
  assert.equal(parsed.password, '[REDACTED]');
});

test('redactEntry redacts JSON array body', () => {
  const entry = {
    id: '3',
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://localhost:3000/bulk',
    headers: {},
    body: JSON.stringify([
      { user: 'a', token: 't1' },
      { user: 'b', token: 't2' },
    ]),
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const result = redactEntry(entry);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed[0].user, 'a');
  assert.equal(parsed[0].token, '[REDACTED]');
  assert.equal(parsed[1].token, '[REDACTED]');
});

test('redactEntry redacts form-encoded body', () => {
  const entry = {
    id: '4',
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://localhost:3000/login',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=alice&password=hunter2&remember=1',
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const result = redactEntry(entry);
  assert.equal(result.body, 'username=alice&password=[REDACTED]&remember=1');
});

test('redactEntry leaves plain text body untouched', () => {
  const entry = {
    id: '5',
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://localhost:3000/echo',
    headers: {},
    body: 'Hello, this is a plain text body',
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const result = redactEntry(entry);
  assert.equal(result.body, 'Hello, this is a plain text body');
});

test('redactEntry handles entry without body', () => {
  const entry = {
    id: '6',
    timestamp: Date.now(),
    method: 'GET',
    url: 'http://localhost:3000/health',
    headers: {},
    response: { status: 200, statusText: 'OK', duration: 10, size: 50 },
  };
  const result = redactEntry(entry);
  assert.equal(result.body, undefined);
});

test('redactEntry does not mutate original entry', () => {
  const entry = {
    id: '7',
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://localhost:3000/login',
    headers: { Authorization: 'Bearer secret' },
    body: JSON.stringify({ password: '123' }),
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const originalHeaders = { ...entry.headers };
  const originalBody = entry.body;
  redactEntry(entry);
  assert.deepEqual(entry.headers, originalHeaders);
  assert.equal(entry.body, originalBody);
});

test('redactEntry handles deeply nested JSON', () => {
  const entry = {
    id: '8',
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://localhost:3000/config',
    headers: {},
    body: JSON.stringify({
      settings: {
        auth: {
          api_secret: 'deep_secret',
          region: 'us-east-1',
        },
      },
    }),
    response: { status: 200, statusText: 'OK', duration: 50, size: 100 },
  };
  const result = redactEntry(entry);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.settings.auth.api_secret, '[REDACTED]');
  assert.equal(parsed.settings.auth.region, 'us-east-1');
});
