const test = require('node:test');
const assert = require('node:assert/strict');

const { SnapshotScheduler } = require('./snapshotScheduler');

function makeSnapshot(projectPath) {
  return {
    processes: [],
    ports: [],
    connections: [],
    graph: {
      nodes: [
        {
          id: 'proc-1',
          pid: 1,
          name: 'node',
          command: 'node server.js',
          type: 'nodejs',
          cpu: 0,
          memory: 0,
          user: 'me',
          tty: null,
          project: projectPath ? 'demo-stack' : null,
          projectPath: projectPath || null,
          repoPath: '/Users/me/fere',
          ports: [],
          routes: [],
          healthStatus: 'green',
          lastSeen: Date.now(),
        },
      ],
      edges: [],
    },
    docker: null,
    meta: {
      collectedAt: Date.now(),
      processesAgeMs: 0,
      portsAgeMs: 0,
      connectionsAgeMs: 0,
    },
  };
}

test('computeDelta includes projectPath updates for existing nodes', () => {
  const scheduler = new SnapshotScheduler();
  scheduler.previousSnapshot = makeSnapshot('/Users/me/demo-stack');

  const second = scheduler.computeDelta(makeSnapshot(null));
  assert.equal(second.type, 'metrics');
  assert.ok(second.graph?.nodes?.modified?.length, 'expected modified node patch');

  const patch = second.graph.nodes.modified[0];
  assert.equal(patch.id, 'proc-1');
  assert.equal(patch.projectPath, null);
  assert.equal(patch.project, null);
});
