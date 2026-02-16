const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildConnectionGraph,
  categorizeProcess,
  inferProjectPathFromCommand,
} = require('./connectionGraph');

function makeTempDir() {
  return fs.mkdtempSync(path.join(process.cwd(), 'tmp-graph-'));
}

test('buildConnectionGraph maps connections to internal and external nodes', async () => {
  const snapshot = {
    processes: [
      { pid: 100, name: 'node', command: 'node server.js', cpu: 1, memory: 1, user: 'me', tty: 'ttys001' },
      { pid: 200, name: 'python', command: 'python server.py', cpu: 1, memory: 1, user: 'me', tty: 'ttys002' },
    ],
    ports: [
      { port: 3001, host: '127.0.0.1', pid: 100, process: 'node', user: 'me', protocol: 'tcp' },
      { port: 5001, host: '127.0.0.1', pid: 200, process: 'python', user: 'me', protocol: 'tcp' },
    ],
    connections: [
      { pid: 100, process: 'node', user: 'me', localHost: '127.0.0.1', localPort: 60000, remoteHost: '127.0.0.1', remotePort: 5001, protocol: 'tcp' },
      { pid: 100, process: 'node', user: 'me', localHost: '127.0.0.1', localPort: 60001, remoteHost: 'example.com', remotePort: 443, protocol: 'tcp' },
    ],
  };

  const { nodes, edges } = await buildConnectionGraph(snapshot);
  const nodeIds = new Set(nodes.map(n => n.id));

  assert.ok(nodeIds.has('proc-100'));
  assert.ok(nodeIds.has('proc-200'));
  assert.ok(Array.from(nodeIds).some(id => id.startsWith('external-')));
  const proc100Edges = edges.filter(e => e.source === 'proc-100');
  assert.equal(proc100Edges.length, 2);

  const internalEdge = edges.find(e => e.target === 'proc-200');
  assert.ok(internalEdge);
  assert.equal(internalEdge.source, 'proc-100');
  assert.equal(internalEdge.targetPort, 5001);
});

test('categorizeProcess detects common service types', () => {
  assert.equal(categorizeProcess('postgres', 'postgres'), 'database');
  assert.equal(categorizeProcess('redis', 'redis'), 'cache');
  assert.equal(categorizeProcess('nginx', 'nginx'), 'webserver');
  assert.equal(categorizeProcess('node', 'vite dev'), 'frontend');
  assert.equal(categorizeProcess('python', 'uvicorn app:app'), 'backend');
});

test('inferProjectPathFromCommand prefers git root', () => {
  const root = makeTempDir();
  const nested = path.join(root, 'src', 'server');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(nested, { recursive: true });

  try {
    const serverPath = path.join(nested, 'server.js');
    fs.writeFileSync(serverPath, 'console.log("ok");');
    const cmd = `node ${serverPath}`;
    const projectPath = inferProjectPathFromCommand(cmd);
    assert.equal(projectPath, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inferProjectPathFromCommand falls back to marker files', () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), 'tmp-graph-'));
  const nested = path.join(root, 'api');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  try {
    const serverPath = path.join(nested, 'server.js');
    fs.writeFileSync(serverPath, 'console.log("ok");');
    const cmd = `node ${serverPath}`;
    const projectPath = inferProjectPathFromCommand(cmd);
    // Should find the real project root, never collapse to $HOME
    // even if ~/.git exists (e.g. for dotfile management)
    assert.equal(projectPath, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
