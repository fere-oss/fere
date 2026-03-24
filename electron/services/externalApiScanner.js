const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const CODE_EXTENSIONS = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.go', '.rb', '.php', '.java', '.kt']);
const EXTRA_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'venv',
  '.venv',
  'dist',
  'build',
  '.next',
  '.cache',
  '.nvm',
  '.npm',
  '.yarn',
  '.pnpm-store',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  'coverage',
  'docs',
]);

const MAX_FILES = 2500;
const API_CACHE_TTL_MS = 60000;
const apiCache = new Map();
const MAX_FILE_BYTES = 1024 * 1024; // 1MB
const { SYSTEM_PROJECT_ROOTS } = require('./platform');
const BLOCKED_HOSTS = new Set([
  'www.w3.org',
  'w3.org',
  'github.com',
  'bit.ly',
  'example.com',
  'api.example.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

const URL_REGEX = /\bhttps?:\/\/[^\s"'`<>]+/gi;

const PROVIDER_FILE_PATH = path.resolve(__dirname, '..', '..', 'config', 'api-providers.json');
const USER_PROVIDER_FILE_PATH = path.join(os.homedir(), '.fere', 'api-providers.json');
const PROVIDER_CACHE_TTL_MS = 10000;
const providerCache = { timestamp: 0, signature: '', providers: [] };

function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function isLocalHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  if (normalized === 'localhost') return true;
  if (normalized === '0.0.0.0') return true;
  if (normalized === '::1') return true;
  if (normalized.startsWith('127.')) return true;
  if (normalized.endsWith('.local')) return true;
  return false;
}

function isPrivateIp(host) {
  const ipVersion = net.isIP(host);
  if (!ipVersion) return false;

  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return false;

    // RFC1918 + common local-only ranges
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }

  const normalized = host.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
}

function isReservedTestHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;

  if (normalized === 'example.com' || normalized.endsWith('.example.com')) return true;
  if (normalized === 'example.org' || normalized.endsWith('.example.org')) return true;
  if (normalized === 'example.net' || normalized.endsWith('.example.net')) return true;
  if (normalized.endsWith('.example')) return true;
  if (normalized.endsWith('.test')) return true;
  if (normalized.endsWith('.invalid')) return true;
  return false;
}

function isValidPublicHostname(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (normalized.includes('${') || normalized.includes('}')) return false;
  if (!normalized.includes('.')) return false;

  // Basic RFC-style hostname validation (ascii/punycode labels).
  const labels = normalized.split('.');
  if (labels.some(label => !label || label.length > 63)) return false;
  if (labels.some(label => label.startsWith('-') || label.endsWith('-'))) return false;
  if (labels.some(label => !/^[a-z0-9-]+$/i.test(label))) return false;

  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/i.test(tld) && !/^xn--[a-z0-9-]{2,59}$/i.test(tld)) return false;
  return true;
}

function isIgnoredHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  if (!isValidPublicHostname(normalized)) return true;
  if (isLocalHost(normalized)) return true;
  if (isPrivateIp(normalized)) return true;
  if (isReservedTestHost(normalized)) return true;
  return BLOCKED_HOSTS.has(normalized);
}

function shouldSkipFile(filePath) {
  const fileName = path.basename(filePath).toLowerCase();
  return (
    fileName.includes('.test.') ||
    fileName.includes('.spec.') ||
    fileName.includes('.mock.') ||
    fileName.includes('-mock.') ||
    fileName.endsWith('.d.ts')
  );
}

function shouldSkipExternalApiProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return true;
  const resolved = path.resolve(projectPath).toLowerCase();
  return SYSTEM_PROJECT_ROOTS.some(root =>
    resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
}

function findApiFiles(dir, files = []) {
  try {
    if (files.length >= MAX_FILES) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          findApiFiles(fullPath, files);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return files;
}

function findEnvFiles(projectPath) {
  const envFiles = [];
  for (const envName of EXTRA_FILES) {
    const envPath = path.join(projectPath, envName);
    if (fs.existsSync(envPath)) {
      envFiles.push(envPath);
    }
  }
  return envFiles;
}

function loadProviderFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.providers)) return parsed.providers;
  } catch (error) {
    return [];
  }
  return [];
}

function compilePatterns(patterns) {
  const compiled = [];
  for (const entry of patterns || []) {
    try {
      if (typeof entry === 'string') {
        compiled.push(new RegExp(entry, 'i'));
        continue;
      }
      if (entry && typeof entry.pattern === 'string') {
        compiled.push(new RegExp(entry.pattern, entry.flags || 'i'));
      }
    } catch (err) {
      // Skip malformed regex patterns rather than crashing the scanner
      console.error('[ExternalApiScanner] Invalid regex pattern, skipping:', entry, err.message);
    }
  }
  return compiled;
}

function normalizeProvider(provider) {
  if (!provider || !provider.name) return null;
  return {
    name: provider.name,
    domains: Array.isArray(provider.domains)
      ? provider.domains.map(domain => domain.toLowerCase())
      : [],
    sdkPatterns: compilePatterns(provider.sdkPatterns),
    envPatterns: compilePatterns(provider.envPatterns),
  };
}

function getProviderSignature(paths) {
  return paths.map(filePath => {
    try {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.mtimeMs}`;
    } catch (error) {
      return `${filePath}:0`;
    }
  }).join('|');
}

function loadProviders() {
  const paths = [PROVIDER_FILE_PATH, USER_PROVIDER_FILE_PATH];
  const signature = getProviderSignature(paths);
  const now = Date.now();

  if (providerCache.providers.length &&
      now - providerCache.timestamp < PROVIDER_CACHE_TTL_MS &&
      providerCache.signature === signature) {
    return providerCache.providers;
  }

  const baseProviders = loadProviderFile(PROVIDER_FILE_PATH);
  const userProviders = loadProviderFile(USER_PROVIDER_FILE_PATH);
  const merged = new Map();

  for (const provider of baseProviders.concat(userProviders)) {
    const normalized = normalizeProvider(provider);
    if (!normalized) continue;
    merged.set(normalized.name.toLowerCase(), normalized);
  }

  const providers = Array.from(merged.values());
  providerCache.providers = providers;
  providerCache.signature = signature;
  providerCache.timestamp = now;
  return providers;
}

function recordProviderMatch(map, provider, matchType, host) {
  if (!map.has(provider.name)) {
    map.set(provider.name, {
      name: provider.name,
      kind: 'provider',
      matchedOn: new Set(),
      hosts: new Set(),
    });
  }
  const entry = map.get(provider.name);
  entry.matchedOn.add(matchType);
  if (host) entry.hosts.add(normalizeHost(host));
}

function extractHosts(content, alreadyStripped = false) {
  const hosts = new Set();
  const sanitized = alreadyStripped ? content : stripComments(content);
  const matches = sanitized.match(URL_REGEX) || [];

  for (const match of matches) {
    const cleaned = match.replace(/[),.;]+$/, '');
    try {
      const url = new URL(cleaned);
      const host = normalizeHost(url.hostname);
      if (host && !isIgnoredHost(host)) {
        hosts.add(host);
      }
    } catch (error) {
      // Ignore malformed URLs
    }
  }

  return hosts;
}

// Single combined regex for stripping all comment styles in one pass
const COMMENT_REGEX = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$|^\s*#.*$|<!--[\s\S]*?-->/gm;

function stripComments(content) {
  return content.replace(COMMENT_REGEX, '');
}

async function scanExternalApis(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath) || shouldSkipExternalApiProjectPath(projectPath)) {
    return [];
  }

  const providers = loadProviders();
  const cached = apiCache.get(projectPath);
  const now = Date.now();
  if (cached) {
    if (cached.apis.length && now - cached.timestamp < API_CACHE_TTL_MS) {
      return cached.apis;
    }
    if (cached.promise) {
      return cached.promise;
    }
  }

  const scanPromise = (async () => {
    const providerMatches = new Map();
    const hostMatches = new Set();
    const ignoredFiles = new Set([PROVIDER_FILE_PATH, USER_PROVIDER_FILE_PATH]);

    const envFiles = findEnvFiles(projectPath);
    const envFileSet = new Set(envFiles);
    const files = findApiFiles(projectPath).concat(envFiles);

    for (const filePath of files) {
      if (ignoredFiles.has(filePath)) continue;
      if (shouldSkipFile(filePath)) continue;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_BYTES) continue;
        const content = fs.readFileSync(filePath, 'utf-8');
        const sanitizedContent = stripComments(content);
        const hosts = extractHosts(sanitizedContent, true);
        for (const host of hosts) {
          hostMatches.add(host);
        }

        const isEnvFile = envFileSet.has(filePath);
        for (const provider of providers) {
          // Avoid SDK-name false positives from env var names like ALGOLIA_API_KEY.
          if (!isEnvFile && provider.sdkPatterns.some(pattern => pattern.test(sanitizedContent))) {
            recordProviderMatch(providerMatches, provider, 'sdk');
          }
          if (provider.envPatterns.some(pattern => pattern.test(sanitizedContent))) {
            recordProviderMatch(providerMatches, provider, 'env');
          }
        }
      } catch (error) {
        // Skip unreadable files
      }
    }

    for (const host of hostMatches) {
      let matchedProvider = false;
      for (const provider of providers) {
        if (provider.domains.some(domain => host.endsWith(domain))) {
          recordProviderMatch(providerMatches, provider, 'domain', host);
          matchedProvider = true;
        }
      }
      if (!matchedProvider) {
        providerMatches.set(host, {
          name: host,
          kind: 'host',
          matchedOn: new Set(['url']),
          hosts: new Set([host]),
        });
      }
    }

    const apis = Array.from(providerMatches.values())
      .map(entry => ({
        name: entry.name,
        kind: entry.kind,
        matchedOn: Array.from(entry.matchedOn),
        hosts: Array.from(entry.hosts),
      }))
      .filter(entry => {
        // Env-only matches are very noisy (template/local env files often contain
        // many provider keys that are not actually used by this project).
        if (entry.kind !== 'provider') return true;
        const onlyEnv = entry.matchedOn.length === 1 && entry.matchedOn[0] === 'env';
        const onlySdk = entry.matchedOn.length === 1 && entry.matchedOn[0] === 'sdk';
        const hasEnvAndSdk = entry.matchedOn.includes('env') && entry.matchedOn.includes('sdk');
        const hasHostEvidence = Array.isArray(entry.hosts) && entry.hosts.length > 0;
        if (hasHostEvidence) return true;
        if (hasEnvAndSdk) return true;
        return !onlyEnv && !onlySdk;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    apiCache.set(projectPath, { timestamp: Date.now(), apis, promise: null });
    return apis;
  })();

  apiCache.set(projectPath, { timestamp: now, apis: cached?.apis || [], promise: scanPromise });
  return scanPromise;
}

module.exports = {
  scanExternalApis,
  shouldSkipExternalApiProjectPath,
};
