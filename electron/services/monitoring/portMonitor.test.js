const test = require("node:test");
const assert = require("node:assert/strict");

const { parseListeningPorts, parseConnections } = require("./portMonitor");

test("parseListeningPorts handles basic lsof output", () => {
  const output = [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    "node 123 user 12u IPv4 0x01 0t0 TCP *:3001 (LISTEN)",
    "python 456 user 10u IPv4 0x02 0t0 TCP 127.0.0.1:5001 (LISTEN)",
  ].join("\n");

  const ports = parseListeningPorts(output);
  assert.equal(ports.length, 2);

  const nodePort = ports.find((p) => p.pid === 123);
  assert.equal(nodePort.port, 3001);
  assert.equal(nodePort.host, "*");
  assert.equal(nodePort.process, "node");

  const pyPort = ports.find((p) => p.pid === 456);
  assert.equal(pyPort.port, 5001);
  assert.equal(pyPort.host, "127.0.0.1");
  assert.equal(pyPort.process, "python");
});

test("parseConnections handles established connections", () => {
  const output = [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    "node 123 user 15u IPv4 0x03 0t0 TCP 127.0.0.1:52341->127.0.0.1:5001 (ESTABLISHED)",
  ].join("\n");

  const conns = parseConnections(output);
  assert.equal(conns.length, 1);
  assert.equal(conns[0].pid, 123);
  assert.equal(conns[0].localPort, 52341);
  assert.equal(conns[0].remotePort, 5001);
  assert.equal(conns[0].remoteHost, "127.0.0.1");
});
