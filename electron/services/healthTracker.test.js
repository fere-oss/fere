const test = require('node:test');
const assert = require('node:assert/strict');

const {
  updateHealthTracking,
  getHealthStatus,
  resetHealthTracking,
} = require('./healthTracker');

test.afterEach(() => {
  resetHealthTracking();
});

test('non-listening process with CPU activity is marked active', () => {
  const pid = 501;
  updateHealthTracking({
    processes: [
      { pid, cpu: 1.2 },
    ],
    ports: [],
    connections: [],
  });

  const status = getHealthStatus(pid, false, false, { cpu: 1.2 });
  assert.equal(status.healthStatus, 'green');
});

test('non-listening process without activity is idle', () => {
  const pid = 502;
  updateHealthTracking({
    processes: [
      { pid, cpu: 0.0 },
    ],
    ports: [],
    connections: [],
  });

  const status = getHealthStatus(pid, false, false, { cpu: 0.0 });
  assert.equal(status.healthStatus, 'yellow');
});

test('listening process with no recent traffic is idle', () => {
  const pid = 503;
  updateHealthTracking({
    processes: [
      { pid, cpu: 0.0 },
    ],
    ports: [{ pid }],
    connections: [],
  });

  const status = getHealthStatus(pid, true, false, { cpu: 0.0 });
  assert.equal(status.healthStatus, 'yellow');
});
