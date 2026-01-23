#!/usr/bin/env node
/**
 * Background worker with no listening port.
 */
let counter = 0;
const timer = setInterval(() => {
  counter += 1;
  if (counter % 5 === 0) {
    process.stdout.write(`worker heartbeat ${counter}\n`);
  }
}, 1000);

process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
