/**
 * Fere Share Server
 *
 * Stores graph snapshot HTML and serves it via a unique URL.
 * Deploy to Railway (hobby plan) — mount a volume at /data for persistence.
 *
 * Environment variables:
 *   PORT         - HTTP port (default: 3001, Railway sets this automatically)
 *   DATABASE_PATH - SQLite file path (default: /data/shares.db, or ./shares.db locally)
 */

const express = require('express');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DATABASE_PATH
  || (fs.existsSync('/data') ? '/data/shares.db' : path.join(__dirname, 'shares.db'));

// Ensure parent directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY,
    html       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

const insertShare = db.prepare(`
  INSERT INTO shares (id, html, created_at, updated_at)
  VALUES (@id, @html, @now, @now)
`);

const updateShare = db.prepare(`
  UPDATE shares SET html = @html, updated_at = @now WHERE id = @id
`);

const getShare = db.prepare(`SELECT html FROM shares WHERE id = ?`);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Allow up to 8 MB JSON bodies (graph HTML snapshots can be a few hundred KB
// with embedded screenshot base64)
app.use(express.json({ limit: '8mb' }));

// Basic security headers
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// POST /api/shares — create a new share
// ---------------------------------------------------------------------------
app.post('/api/shares', (req, res) => {
  const { html } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html is required' });
  }
  if (html.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'html too large (max 8 MB)' });
  }

  const id = randomUUID();
  const now = Date.now();
  insertShare.run({ id, html, now });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ id, url: `${baseUrl}/s/${id}` });
});

// ---------------------------------------------------------------------------
// PUT /api/shares/:id — update an existing share
// ---------------------------------------------------------------------------
app.put('/api/shares/:id', (req, res) => {
  const { id } = req.params;
  const { html } = req.body;

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html is required' });
  }

  const result = updateShare.run({ id, html, now: Date.now() });
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Share not found' });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ id, url: `${baseUrl}/s/${id}` });
});

// ---------------------------------------------------------------------------
// GET /s/:id — serve the HTML snapshot
// ---------------------------------------------------------------------------
app.get('/s/:id', (req, res) => {
  const row = getShare.get(req.params.id);
  if (!row) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Not Found</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:10vh auto;padding:24px;color:#262626}</style></head>
<body><h2>Share not found</h2><p>This snapshot may have expired or the link may be incorrect.</p></body></html>`);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(row.html);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3001', 10);
app.listen(PORT, () => {
  console.log(`Fere share server running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
