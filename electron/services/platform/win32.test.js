const test = require('node:test');
const assert = require('node:assert/strict');

// Import the win32 module directly (works on any platform for unit testing
// since the parsers are pure functions with no OS calls).
const win32 = require('./win32');

// ============================================
// netstat parser tests
// ============================================

test('parseListeningPorts handles basic netstat -ano output', () => {
  const output = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1120',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       5678',
    '  TCP    192.168.1.5:49876      52.114.128.40:443      ESTABLISHED     9012',
    '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       5678',
  ].join('\r\n');

  const ports = win32.parseListeningPorts(output);
  assert.equal(ports.length, 3);

  const port135 = ports.find(p => p.port === 135);
  assert.ok(port135);
  assert.equal(port135.pid, 1120);
  assert.equal(port135.host, '0.0.0.0');
  assert.equal(port135.protocol, 'tcp');

  const port3000 = ports.find(p => p.port === 3000);
  assert.ok(port3000);
  assert.equal(port3000.pid, 5678);
  assert.equal(port3000.host, '127.0.0.1');

  // ESTABLISHED line should NOT appear in listening ports
  const port49876 = ports.find(p => p.port === 49876);
  assert.equal(port49876, undefined);
});

test('parseListeningPorts handles IPv6 addresses', () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
    '  TCP    [::1]:3000             [::]:0                 LISTENING       9999',
    '  TCP    [fe80::1%12]:1234      [::]:0                 LISTENING       8888',
  ].join('\r\n');

  const ports = win32.parseListeningPorts(output);
  assert.equal(ports.length, 3);

  const port445 = ports.find(p => p.port === 445);
  assert.ok(port445);
  assert.equal(port445.host, '::');
  assert.equal(port445.pid, 4);

  const port3000 = ports.find(p => p.port === 3000);
  assert.ok(port3000);
  assert.equal(port3000.host, '::1');
  assert.equal(port3000.pid, 9999);

  const port1234 = ports.find(p => p.port === 1234);
  assert.ok(port1234);
  assert.equal(port1234.host, 'fe80::1%12');
});

test('parseListeningPorts deduplicates by port+pid', () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       5678',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       5678',
    '  TCP    [::]:3000              [::]:0                 LISTENING       5678',
  ].join('\r\n');

  const ports = win32.parseListeningPorts(output);
  // All three are same port+pid, should deduplicate to 1
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 3000);
  assert.equal(ports[0].pid, 5678);
});

test('parseEstablishedConnections handles basic output', () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    192.168.1.5:49876      52.114.128.40:443      ESTABLISHED     9012',
    '  TCP    127.0.0.1:52341        127.0.0.1:5001         ESTABLISHED     1234',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       5678',
  ].join('\r\n');

  const conns = win32.parseEstablishedConnections(output);
  assert.equal(conns.length, 2);

  const ext = conns.find(c => c.remotePort === 443);
  assert.ok(ext);
  assert.equal(ext.pid, 9012);
  assert.equal(ext.localHost, '192.168.1.5');
  assert.equal(ext.localPort, 49876);
  assert.equal(ext.remoteHost, '52.114.128.40');
  assert.equal(ext.protocol, 'tcp');

  const local = conns.find(c => c.remotePort === 5001);
  assert.ok(local);
  assert.equal(local.pid, 1234);
  assert.equal(local.localPort, 52341);
  assert.equal(local.remoteHost, '127.0.0.1');

  // LISTENING line should NOT appear in established connections
  assert.equal(conns.find(c => c.localPort === 3000), undefined);
});

test('parseEstablishedConnections handles IPv6', () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    [::1]:52000            [::1]:3000             ESTABLISHED     7777',
  ].join('\r\n');

  const conns = win32.parseEstablishedConnections(output);
  assert.equal(conns.length, 1);
  assert.equal(conns[0].localHost, '::1');
  assert.equal(conns[0].localPort, 52000);
  assert.equal(conns[0].remoteHost, '::1');
  assert.equal(conns[0].remotePort, 3000);
  assert.equal(conns[0].pid, 7777);
});

test('parseListeningPorts returns empty for empty input', () => {
  assert.deepEqual(win32.parseListeningPorts(''), []);
  assert.deepEqual(win32.parseListeningPorts(null), []);
  assert.deepEqual(win32.parseListeningPorts(undefined), []);
});

test('parseEstablishedConnections returns empty for empty input', () => {
  assert.deepEqual(win32.parseEstablishedConnections(''), []);
  assert.deepEqual(win32.parseEstablishedConnections(null), []);
  assert.deepEqual(win32.parseEstablishedConnections(undefined), []);
});

// ============================================
// Process list parser tests
// ============================================

test('parseProcessList handles wmic CSV output', () => {
  // wmic alphabetizes columns and prepends Node (hostname)
  const output = [
    'Node,CommandLine,Name,ProcessId,VirtualSize,WorkingSetSize',
    'DESKTOP-ABC,node server.js,node.exe,1234,1234567890,65536000',
    'DESKTOP-ABC,python app.py,python.exe,5678,987654321,32768000',
  ].join('\r\n');

  const procs = win32.parseProcessList(output);
  assert.equal(procs.length, 2);

  const nodeProc = procs.find(p => p.pid === 1234);
  assert.ok(nodeProc);
  assert.equal(nodeProc.command, 'node server.js');
  assert.ok(nodeProc.rss > 0); // WorkingSetSize / 1024

  const pyProc = procs.find(p => p.pid === 5678);
  assert.ok(pyProc);
  assert.equal(pyProc.command, 'python app.py');
});

test('parseProcessList handles PowerShell JSON output', () => {
  const output = JSON.stringify([
    { ProcessId: 1234, Name: 'node.exe', CommandLine: 'node server.js', WorkingSetSize: 65536000, VirtualSize: 1234567890 },
    { ProcessId: 5678, Name: 'python.exe', CommandLine: 'python app.py', WorkingSetSize: 32768000, VirtualSize: 987654321 },
  ]);

  const procs = win32.parseProcessList(output);
  assert.equal(procs.length, 2);
  assert.equal(procs[0].pid, 1234);
  assert.equal(procs[0].command, 'node server.js');
});

test('parseProcessList skips PID 0', () => {
  const output = JSON.stringify([
    { ProcessId: 0, Name: 'System Idle Process', CommandLine: '', WorkingSetSize: 0, VirtualSize: 0 },
    { ProcessId: 4, Name: 'System', CommandLine: '', WorkingSetSize: 100000, VirtualSize: 200000 },
  ]);

  const procs = win32.parseProcessList(output);
  assert.equal(procs.length, 1);
  assert.equal(procs[0].pid, 4);
});

// ============================================
// App name extraction tests
// ============================================

test('extractAppNameFromCommand handles Program Files paths', () => {
  assert.equal(
    win32.extractAppNameFromCommand('C:\\Program Files\\Slack\\slack.exe --startup'),
    'Slack'
  );
  assert.equal(
    win32.extractAppNameFromCommand('C:\\Program Files (x86)\\Steam\\steam.exe'),
    'Steam'
  );
});

test('extractAppNameFromCommand handles AppData paths', () => {
  assert.equal(
    win32.extractAppNameFromCommand('C:\\Users\\dev\\AppData\\Local\\Programs\\Discord\\Discord.exe'),
    'Discord'
  );
  assert.equal(
    win32.extractAppNameFromCommand('C:\\Users\\dev\\AppData\\Local\\Slack\\slack.exe'),
    'Slack'
  );
});

test('extractAppNameFromCommand returns null for unrecognized paths', () => {
  assert.equal(win32.extractAppNameFromCommand('node server.js'), null);
  assert.equal(win32.extractAppNameFromCommand(''), null);
  assert.equal(win32.extractAppNameFromCommand(undefined), null);
});

// ============================================
// Constant exports tests
// ============================================

test('DOCKER_BIN_CANDIDATES includes Windows paths', () => {
  assert.ok(win32.DOCKER_BIN_CANDIDATES.length > 0);
  // Should include the docker fallback
  assert.ok(win32.DOCKER_BIN_CANDIDATES.includes('docker'));
  // Should include a Program Files path
  assert.ok(win32.DOCKER_BIN_CANDIDATES.some(p => p.includes('Program Files')));
});

test('PLATFORM_KNOWN_SERVICES includes Windows system services', () => {
  assert.ok(win32.PLATFORM_KNOWN_SERVICES['svchost.exe']);
  assert.ok(win32.PLATFORM_KNOWN_SERVICES['explorer.exe']);
  assert.ok(win32.PLATFORM_KNOWN_SERVICES['dwm.exe']);
  assert.ok(win32.PLATFORM_KNOWN_SERVICES['wsl.exe']);
});

test('HOME_DIR_PATH_PREFIXES are Windows-style', () => {
  assert.ok(win32.HOME_DIR_PATH_PREFIXES.some(p => p.includes('C:\\')));
});

test('shouldQuitOnAllWindowsClosed returns true on Windows', () => {
  assert.equal(win32.shouldQuitOnAllWindowsClosed(), true);
});

test('getWindowOptions returns empty object for default Windows title bar', () => {
  const opts = win32.getWindowOptions();
  assert.equal(opts.titleBarStyle, undefined);
  assert.equal(opts.trafficLightPosition, undefined);
});
