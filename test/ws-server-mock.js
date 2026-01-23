#!/usr/bin/env node
/**
 * Mock WebSocket-like server using raw TCP.
 */
const net = require('net');

const PORT = parseInt(process.env.PORT || '8081', 10);

const server = net.createServer(socket => {
  socket.setKeepAlive(true, 10000);
  const timer = setInterval(() => {
    socket.write('ping\n');
  }, 5000);

  socket.on('close', () => clearInterval(timer));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WS mock listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
