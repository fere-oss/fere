#!/usr/bin/env node
/**
 * Mock message broker (NATS-style) over TCP.
 */
const net = require('net');

const PORT = parseInt(process.env.PORT || '4222', 10);

const server = net.createServer(socket => {
  socket.setKeepAlive(true, 10000);
  socket.on('data', data => {
    const msg = data.toString();
    if (msg.includes('PING')) {
      socket.write('PONG\r\n');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Broker mock listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
