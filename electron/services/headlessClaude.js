/**
 * headlessClaude.js
 *
 * Spawns Claude Code in headless mode (`claude -p`) with the Fere MCP server
 * attached so a one-shot Claude invocation can pull live runtime data from
 * Fere while it investigates a finding. Output is parsed as stream-json so we
 * can forward tool-call events back to the renderer in real time.
 *
 * This is the "Fere → Claude" direction: the user clicks Investigate on a
 * Sentinel finding and Fere drives Claude through the Agent SDK headless API.
 * The reverse direction (Claude → Fere data) is the MCP server in mcpBridge.js.
 *
 * Security:
 *   - Allowed tools restricted to Fere MCP tools + Read/Grep/Glob.
 *   - Bash, Edit, Write are *not* allowed — destructive actions go through
 *     the apply_fix MCP tool which itself requires HITL approval in Fere.
 *   - cwd pinned to the project path of the affected service.
 */

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execFileP = promisify(execFile);

const ALLOWED_TOOLS = [
  'mcp__fere__list_findings',
  'mcp__fere__get_service',
  'mcp__fere__get_topology',
  'mcp__fere__list_routes',
  'mcp__fere__list_external_apis',
  'mcp__fere__get_logs',
  'mcp__fere__apply_fix',
  'Read',
  'Grep',
  'Glob',
];

// ─── Claude detection ─────────────────────────────────────────────────────────

let _claudeAvailable = null;

async function isClaudeAvailable() {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    await execFileP('claude', ['--version'], { timeout: 5000 });
    _claudeAvailable = true;
  } catch {
    _claudeAvailable = false;
  }
  return _claudeAvailable;
}

// ─── MCP config file ─────────────────────────────────────────────────────────

function resolveMcpShimPath() {
  // electron/services/headlessClaude.js → ../../bin/fere-mcp.js
  // In packaged builds bin/ is asarUnpack'd; resolve through app.asar.unpacked.
  const dev = path.resolve(__dirname, '..', '..', 'bin', 'fere-mcp.js');
  if (fs.existsSync(dev)) return dev;
  const unpacked = dev.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (fs.existsSync(unpacked)) return unpacked;
  return dev; // best effort — let spawn surface the error
}

function writeMcpConfig() {
  const dir = path.join(os.homedir(), '.fere');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'claude-mcp-config.json');
  const config = {
    mcpServers: {
      fere: {
        command: process.execPath,
        args: [resolveMcpShimPath()],
        env: {
          // Electron's helper env can leak; explicitly clear ELECTRON_RUN_AS_NODE
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}

// ─── Prompt template ─────────────────────────────────────────────────────────

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
  lines.push(`(a) call mcp__fere__apply_fix with finding_id="${finding.id}" to apply the attached fix (Fere will prompt the user for approval), or`);
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

// ─── Stream parser ───────────────────────────────────────────────────────────

function parseStreamLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function classifyEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'system') {
    return { kind: 'system', subtype: event.subtype || null };
  }
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        return { kind: 'tool_use', tool: block.name, input: block.input };
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return { kind: 'text', text: block.text };
      }
    }
    return null;
  }
  if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        return { kind: 'tool_result', tool_use_id: block.tool_use_id, isError: !!block.is_error };
      }
    }
    return null;
  }
  if (event.type === 'result') {
    return {
      kind: 'result',
      result: event.result || event.output || null,
      isError: !!event.is_error,
      durationMs: event.duration_ms,
      costUsd: event.total_cost_usd,
    };
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a headless Claude investigation against a Sentinel finding.
 *
 * @param {object} args
 * @param {object} args.finding       Sentinel finding
 * @param {string} args.projectPath   cwd Claude runs in
 * @param {(step: object) => void} [args.onStep]   streaming step callback
 * @returns {Promise<{success: boolean, result?: string, error?: string, durationMs?: number}>}
 */
async function runInvestigation({ finding, projectPath, onStep }) {
  if (!finding || !finding.id) {
    return { success: false, error: 'finding is required' };
  }
  const cwd = projectPath && fs.existsSync(projectPath) ? projectPath : os.homedir();

  if (!(await isClaudeAvailable())) {
    return {
      success: false,
      error:
        'Claude Code is not installed or not on PATH. Install it from https://docs.claude.com/en/docs/claude-code and try again.',
    };
  }

  const configPath = writeMcpConfig();
  const prompt = buildPrompt(finding);

  const args = [
    '-p',
    prompt,
    '--mcp-config',
    configPath,
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, { cwd, env: process.env });
    } catch (err) {
      return resolve({ success: false, error: `failed to spawn claude: ${err.message}` });
    }

    const startedAt = Date.now();
    let stdoutBuf = '';
    let stderrBuf = '';
    let finalResult = null;
    let resultIsError = false;

    const emit = (step) => {
      if (typeof onStep === 'function') {
        try { onStep(step); } catch { /* swallow */ }
      }
    };

    emit({ kind: 'start', finding: { id: finding.id, summary: finding.summary } });

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const event = parseStreamLine(line);
        if (!event) continue;
        const step = classifyEvent(event);
        if (!step) continue;
        if (step.kind === 'result') {
          finalResult = step.result;
          resultIsError = step.isError;
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
        error: `claude spawn error: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0 && !resultIsError) {
        resolve({
          success: true,
          result: finalResult || stdoutBuf || '(no output)',
          durationMs,
        });
      } else {
        resolve({
          success: false,
          error: stderrBuf.trim() || `claude exited with code ${code}`,
          durationMs,
        });
      }
    });
  });
}

module.exports = { runInvestigation, isClaudeAvailable };
