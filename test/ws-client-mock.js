#!/usr/bin/env node
/**
 * Mock WebSocket client that keeps a TCP connection open.
 */
const net = require('net');

const HOST = process.env.WS_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WS_PORT || '8081', 10);

let socket = null;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function connect() {
  socket = net.createConnection({ host: HOST, port: PORT }, () => {
    socket.setKeepAlive(true, 10000);
    socket.write('hello\n');
  });
  socket.on('error', scheduleReconnect);
  socket.on('close', scheduleReconnect);
}

connect();

process.on('SIGINT', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) socket.destroy();
  process.exit(0);
});
