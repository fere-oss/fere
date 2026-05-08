/**
 * Cross-platform binary resolver for agent CLIs.
 *
 * Electron apps launched from the macOS Dock/Finder inherit a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't include common install
 * locations like `/opt/homebrew/bin` or `~/.npm-global/bin`. So a plain
 * `execFile('claude', ...)` will fail with ENOENT even when the CLI is
 * installed.
 *
 * This helper searches PATH first, then a curated list of common install
 * locations on macOS/Linux (and the Windows equivalents).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

function commonBinDirs() {
  const home = os.homedir();
  if (isWin) {
    return [
      path.join(process.env.APPDATA || '', 'npm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Programs'),
    ].filter(Boolean);
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    // nvm — try the current symlink dir, but also a couple recent versions
    path.join(home, '.nvm', 'versions', 'node', 'current', 'bin'),
  ];
}

const _resolutionCache = new Map();

/**
 * Find a binary by name. Returns the absolute path if found, otherwise the
 * original name (so caller can still let spawn() fail naturally with a
 * meaningful ENOENT).
 */
function resolveBinary(name) {
  if (_resolutionCache.has(name)) return _resolutionCache.get(name);

  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const searchDirs = [...pathEntries, ...commonBinDirs()];

  for (const dir of searchDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          _resolutionCache.set(name, candidate);
          return candidate;
        }
      } catch {
        /* not executable here, keep looking */
      }
    }
  }

  _resolutionCache.set(name, name); // cache the negative result too
  return name;
}

function clearCache() {
  _resolutionCache.clear();
}

module.exports = { resolveBinary, clearCache };
