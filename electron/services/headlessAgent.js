/**
 * headlessAgent.js
 *
 * Spawns an AI coding CLI (Claude Code, OpenAI Codex, …) in headless mode
 * with the Fere MCP server attached, so the spawned agent can pull live
 * runtime data while it investigates a Sentinel finding.
 *
 * The "Fere → AI" direction. The reverse direction (AI → Fere data) is the
 * MCP server in mcpBridge.js + bin/fere-mcp.js.
 *
 * Provider-driven: each supported CLI is implemented as an adapter in
 * agentProviders/ that knows how to spawn the CLI and parse its JSONL
 * output. This module owns the spawn lifecycle, the prompt template, and
 * the MCP shim path resolution — all provider-agnostic.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const providers = require('./agentProviders');

// ─── MCP shim path + config file ─────────────────────────────────────────────

function resolveMcpShimPath() {
  // electron/services/headlessAgent.js → ../../bin/fere-mcp.js
  // In packaged builds bin/ is asarUnpack'd; resolve through app.asar.unpacked.
  const dev = path.resolve(__dirname, '..', '..', 'bin', 'fere-mcp.js');
  if (fs.existsSync(dev)) return dev;
  const unpacked = dev.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (fs.existsSync(unpacked)) return unpacked;
  return dev; // best effort
}

function writeMcpConfig() {
  const dir = path.join(os.homedir(), '.fere');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'agent-mcp-config.json');
  const config = {
    mcpServers: {
      fere: {
        command: process.execPath,
        args: [resolveMcpShimPath()],
        env: {
          // Ensure the Electron binary runs as plain Node when invoked here.
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}

// ─── Prompt template (provider-agnostic) ─────────────────────────────────────

function buildPrompt(finding) {
  const lines = [];
  lines.push('You are investigating a runtime issue Sentinel detected in this project.');
  lines.push('');
  lines.push(`Finding ID: ${finding.id}`);
  lines.push(`Severity: ${finding.severity}`);
  lines.push(`Service: ${finding.service}`);
  lines.push(`Summary: ${finding.summary}`);
  if (finding.detail) lines.push(`Detail: ${finding.detail}`);
  if (finding.impact) lines.push(`Impact: ${finding.impact}`);
  if (Array.isArray(finding.affectedServices) && finding.affectedServices.length > 0) {
    lines.push(`Affected: ${finding.affectedServices.join(', ')}`);
  }
  lines.push('');
  lines.push('Use the fere MCP tools to gather evidence:');
  lines.push('- get_service for live state, ports, and recent logs of the affected service');
  lines.push('- get_logs for more log context if it is a Docker container');
  lines.push('- list_routes / list_external_apis when relevant');
  lines.push('- get_topology to see what depends on this service');
  lines.push('');
  lines.push('Then either:');
  lines.push(`(a) call the fere apply_fix tool with finding_id="${finding.id}" to apply the attached fix (Fere will prompt the user for approval), or`);
  lines.push('(b) propose concrete fix steps the user can run themselves.');
  lines.push('');
  lines.push('Respond concisely:');
  lines.push('1. Root cause (1–2 sentences, grounded in tool evidence).');
  lines.push('2. Fix applied or proposed (one short list).');
  lines.push('3. Verification check (one line).');
  lines.push('');
  lines.push('Do not summarize the input back. Do not narrate your reasoning.');
  return lines.join('\n');
}

// ─── Stream parsing ──────────────────────────────────────────────────────────

function parseStreamLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function listProviders() {
  return providers.listAvailable();
}

/**
 * Run a headless investigation against a Sentinel finding using the chosen
 * agent provider.
 *
 * @param {object} args
 * @param {object} args.finding       Sentinel finding
 * @param {string} args.projectPath   cwd the agent runs in
 * @param {string} [args.providerId]  agent provider id (defaults to first detected)
 * @param {(step: object) => void} [args.onStep]  streaming step callback
 * @returns {Promise<{success: boolean, providerId?: string, result?: string, error?: string, durationMs?: number}>}
 */
async function runInvestigation({ finding, projectPath, providerId, onStep }) {
  if (!finding || !finding.id) {
    return { success: false, error: 'finding is required' };
  }

  // Resolve provider (explicit id, or first detected)
  let provider = null;
  if (providerId) {
    provider = providers.getProvider(providerId);
    if (!provider) {
      return { success: false, error: `unknown agent provider: ${providerId}` };
    }
    if (!(await providers.detect(provider))) {
      return {
        success: false,
        providerId,
        error: `${provider.displayName} is not installed. Install with: ${provider.installHint}`,
      };
    }
  } else {
    const all = await providers.listAvailable();
    const first = all.find((p) => p.detected);
    if (!first) {
      return {
        success: false,
        error:
          'No agent CLI detected. Install Claude Code (npm i -g @anthropic-ai/claude-code) or OpenAI Codex (npm i -g @openai/codex) and try again.',
      };
    }
    provider = providers.getProvider(first.id);
  }

  const cwd = projectPath && fs.existsSync(projectPath) ? projectPath : os.homedir();
  const mcpShimPath = resolveMcpShimPath();
  const mcpConfigPath = provider.needsMcpConfigFile ? writeMcpConfig() : null;
  const prompt = buildPrompt(finding);

  const spec = provider.build({ prompt, mcpConfigPath, mcpShimPath, cwd });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd || cwd,
        env: spec.env || process.env,
      });
    } catch (err) {
      return resolve({
        success: false,
        providerId: provider.id,
        error: `failed to spawn ${spec.command}: ${err.message}`,
      });
    }

    const startedAt = Date.now();
    let stdoutBuf = '';
    let stderrBuf = '';
    let finalResult = null;
    let resultIsError = false;
    let lastTextChunk = '';

    const emit = (step) => {
      if (typeof onStep === 'function') {
        try { onStep(step); } catch { /* swallow */ }
      }
    };

    emit({
      kind: 'start',
      providerId: provider.id,
      finding: { id: finding.id, summary: finding.summary },
    });

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const event = parseStreamLine(line);
        if (!event) continue;
        const step = provider.classifyEvent(event);
        if (!step) continue;
        if (step.kind === 'result') {
          finalResult = step.result || lastTextChunk || finalResult;
          resultIsError = step.isError;
        } else if (step.kind === 'text' && step.text) {
          // Buffer text for providers that don't emit a distinct 'result' event
          lastTextChunk = step.text;
        }
        emit(step);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        providerId: provider.id,
        error: `${spec.command} spawn error: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      // Final fallback: if no structured result event was seen, use the last
      // text chunk or any leftover stdout buffer.
      const fallback = finalResult || lastTextChunk || stdoutBuf.trim();
      if (code === 0 && !resultIsError) {
        resolve({
          success: true,
          providerId: provider.id,
          result: fallback || '(no output)',
          durationMs,
        });
      } else {
        resolve({
          success: false,
          providerId: provider.id,
          error: stderrBuf.trim() || `${spec.command} exited with code ${code}`,
          durationMs,
        });
      }
    });
  });
}

module.exports = { runInvestigation, listProviders };
