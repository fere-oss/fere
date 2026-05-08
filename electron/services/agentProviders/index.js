/**
 * Agent provider registry.
 *
 * Each provider is an adapter for a specific AI coding CLI (Claude Code,
 * OpenAI Codex, etc) that knows how to spawn the CLI in headless mode with
 * the Fere MCP attached and how to classify its streaming JSONL output.
 *
 * To add a new provider:
 *   1. Create electron/services/agentProviders/<id>.js exporting
 *      { id, displayName, binary, installHint, needsMcpConfigFile,
 *        detect, build, classifyEvent }
 *   2. Add it to PROVIDERS below.
 */

const claudeCode = require('./claudeCode');
const codex = require('./codex');

const PROVIDERS = [claudeCode, codex];

const _detectionCache = new Map();

async function detect(provider) {
  if (_detectionCache.has(provider.id)) return _detectionCache.get(provider.id);
  const ok = await provider.detect();
  _detectionCache.set(provider.id, ok);
  return ok;
}

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

async function listAvailable() {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => ({
      id: p.id,
      displayName: p.displayName,
      binary: p.binary,
      installHint: p.installHint,
      detected: await detect(p),
    })),
  );
  return results;
}

function clearDetectionCache() {
  _detectionCache.clear();
}

module.exports = {
  PROVIDERS,
  getProvider,
  detect,
  listAvailable,
  clearDetectionCache,
};
