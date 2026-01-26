const fs = require('fs');
const path = require('path');
const os = require('os');

const CODE_EXTENSIONS = ['.py', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.go', '.rb', '.php', '.java', '.kt'];
const EXTRA_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
];

const SKIP_DIRS = [
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
];

const MAX_FILES = 2500;
const API_CACHE_TTL_MS = 60000;
const apiCache = new Map();
const MAX_FILE_BYTES = 1024 * 1024; // 1MB
const BLOCKED_HOSTS = new Set([
  'www.w3.org',
  'w3.org',
  'github.com',
  'bit.ly',
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

function findApiFiles(dir, files = []) {
  try {
    if (files.length >= MAX_FILES) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.includes(entry.name)) {
          findApiFiles(fullPath, files);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.includes(ext)) {
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
    if (typeof entry === 'string') {
      compiled.push(new RegExp(entry, 'i'));
      continue;
    }
    if (entry && typeof entry.pattern === 'string') {
      compiled.push(new RegExp(entry.pattern, entry.flags || 'i'));
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
  if (host) {
    entry.hosts.add(normalizeHost(host));
  }
}

function extractHosts(content) {
  const hosts = new Set();
  const sanitized = stripComments(content);
  const matches = sanitized.match(URL_REGEX) || [];

  for (const match of matches) {
    const cleaned = match.replace(/[),.;]+$/, '');
    try {
      const url = new URL(cleaned);
      const host = normalizeHost(url.hostname);
      if (host && !isLocalHost(host) && !BLOCKED_HOSTS.has(host)) {
        hosts.add(host);
      }
    } catch (error) {
      // Ignore malformed URLs
    }
  }

  return hosts;
}

function stripComments(content) {
  let result = content;
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.replace(/^\s*\/\/.*$/gm, '');
  result = result.replace(/^\s*#.*$/gm, '');
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  return result;
}

async function scanExternalApis(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) {
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

    const files = findApiFiles(projectPath).concat(findEnvFiles(projectPath));

    for (const filePath of files) {
      if (ignoredFiles.has(filePath)) continue;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_BYTES) continue;
        const content = fs.readFileSync(filePath, 'utf-8');
        const sanitizedContent = stripComments(content);
        const hosts = extractHosts(sanitizedContent);
        for (const host of hosts) {
          hostMatches.add(host);
        }

        for (const provider of providers) {
          const hasDomain = provider.domains.some(domain =>
            sanitizedContent.toLowerCase().includes(domain)
          );
          if (hasDomain) {
            recordProviderMatch(providerMatches, provider, 'domain');
          }

          if (provider.sdkPatterns.some(pattern => pattern.test(sanitizedContent))) {
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

    const apis = Array.from(providerMatches.values()).map(entry => ({
      name: entry.name,
      kind: entry.kind,
      matchedOn: Array.from(entry.matchedOn),
      hosts: Array.from(entry.hosts),
    })).sort((a, b) => a.name.localeCompare(b.name));

    apiCache.set(projectPath, { timestamp: Date.now(), apis, promise: null });
    return apis;
  })();

  apiCache.set(projectPath, { timestamp: now, apis: cached?.apis || [], promise: scanPromise });
  return scanPromise;
}

module.exports = {
  scanExternalApis,
};
