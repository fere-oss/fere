#!/usr/bin/env node
/**
 * External connection mock for Fere Dashboard Testing.
 * Keeps a TCP connection open to surface an "external" node.
 */

const net = require('net');

const HOST = process.env.EXTERNAL_HOST || 'example.com';
const PORT = parseInt(process.env.EXTERNAL_PORT || '443', 10);
const RETRY_MS = 2000;

let socket = null;

const connect = () => {
  socket = net.createConnection({ host: HOST, port: PORT }, () => {
    console.log(`External connector established to ${HOST}:${PORT}`);
  });

  socket.on('error', (err) => {
    console.log(`External connector error: ${err.message}`);
    socket.destroy();
  });

  socket.on('close', () => {
    setTimeout(connect, RETRY_MS);
  });
};

connect();

process.on('SIGINT', () => {
  if (socket) {
    socket.destroy();
  }
  process.exit(0);
});
