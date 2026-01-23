#!/usr/bin/env node
/**
 * Periodic HTTP client to generate request edges.
 */
const http = require('http');

const TARGETS = [
  process.env.NODE_TARGET || 'http://127.0.0.1:3001/health',
  process.env.FLASK_TARGET || 'http://127.0.0.1:5001/health',
];

function ping(url) {
  try {
    http.get(url, res => res.resume()).on('error', () => {});
  } catch (err) {
    // Ignore bad URLs.
  }
}

const timer = setInterval(() => {
  TARGETS.forEach(ping);
}, 2000);

process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
