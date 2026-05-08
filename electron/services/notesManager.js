'use strict';

const fs = require('fs');
const path = require('path');

const NOTES_FILENAME = '.fere/notes.json';
const MAX_BODY_LENGTH = 500;

function notesFilePath(projectPath) {
  return path.join(projectPath, NOTES_FILENAME);
}

function readFile(projectPath) {
  try {
    const content = fs.readFileSync(notesFilePath(projectPath), 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.notes && typeof parsed.notes === 'object') {
      return parsed;
    }
  } catch (_) { /* missing or invalid — start fresh */ }
  return { version: 1, notes: {} };
}

function writeFile(projectPath, data) {
  const fereDir = path.join(projectPath, '.fere');
  fs.mkdirSync(fereDir, { recursive: true });
  const filePath = notesFilePath(projectPath);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function listNotes(projectPath) {
  if (!projectPath || projectPath === '__system__') return {};
  return readFile(projectPath).notes || {};
}

function setNote(projectPath, serviceKey, body) {
  if (!projectPath || projectPath === '__system__') {
    throw new Error('Notes require a project path');
  }
  if (typeof serviceKey !== 'string' || !serviceKey) {
    throw new Error('Invalid service key');
  }
  const trimmed = (body == null ? '' : String(body)).slice(0, MAX_BODY_LENGTH);
  const data = readFile(projectPath);
  if (!trimmed.trim()) {
    delete data.notes[serviceKey];
  } else {
    data.notes[serviceKey] = { body: trimmed, updatedAt: Date.now() };
  }
  writeFile(projectPath, data);
  return data.notes[serviceKey] ?? null;
}

function deleteNote(projectPath, serviceKey) {
  if (!projectPath || projectPath === '__system__') return;
  const data = readFile(projectPath);
  if (data.notes[serviceKey]) {
    delete data.notes[serviceKey];
    writeFile(projectPath, data);
  }
}

function listNotesForProjects(projectPaths) {
  const out = {};
  if (!Array.isArray(projectPaths)) return out;
  for (const p of projectPaths) {
    if (!p || p === '__system__') continue;
    const notes = listNotes(p);
    if (Object.keys(notes).length > 0) out[p] = notes;
  }
  return out;
}

module.exports = {
  listNotes,
  listNotesForProjects,
  setNote,
  deleteNote,
  MAX_BODY_LENGTH,
};
