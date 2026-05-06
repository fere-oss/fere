/**
 * OpenAI Codex CLI provider — headless `codex exec --json`.
 *
 * MCP config: Codex doesn't accept a per-invocation --mcp-config flag like
 * Claude Code. It reads MCP server defs from ~/.codex/config.toml. We avoid
 * polluting the user's global config by passing per-invocation `-c` overrides
 * instead — these stack on top of config.toml for this run only.
 *
 * Stream format: --json emits JSONL events. Codex's event shape evolves
 * across versions; we classify defensively, looking for tool_call / agent_message
 * / message / item.* style events.
 *
 * Sandbox: --sandbox read-only is set as a defense-in-depth guard against
 * Codex's *own* shell tools running anything destructive. The Fere apply_fix
 * tool still flows through Fere's HITL approval modal.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveBinary } = require('./_resolveBinary');

const execFileP = promisify(execFile);

async function detect() {
  try {
    await execFileP(resolveBinary('codex'), ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function build({ prompt, mcpShimPath, cwd }) {
  // Per-invocation MCP override into Codex's TOML config namespace.
  // -c expects a key=value where the value is parsed as TOML; strings need
  // quotes and arrays use TOML array syntax.
  const args = [
    'exec',
    '-c', `mcp_servers.fere.command="node"`,
    '-c', `mcp_servers.fere.args=[${JSON.stringify(mcpShimPath)}]`,
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--cd', cwd,
    prompt,
  ];

  return {
    command: resolveBinary('codex'),
    args,
    cwd,
    env: process.env,
  };
}

// Defensive classifier — Codex JSONL has shifted shapes across releases.
// Try the common variants in order; return null for anything unrecognized.
function classifyEvent(event) {
  if (!event || typeof event !== 'object') return null;

  // Some versions wrap payloads under `msg` or `item` keys.
  const inner = event.msg || event.item || event;
  const type = inner.type || event.type;

  // Tool calls — names vary: tool_call, function_call, mcp_tool_call
  if (
    type === 'tool_call' ||
    type === 'function_call' ||
    type === 'mcp_tool_call' ||
    type === 'tool_use'
  ) {
    const tool =
      inner.tool ||
      inner.name ||
      inner.tool_name ||
      (inner.function && inner.function.name) ||
      'tool';
    return { kind: 'tool_use', tool, input: inner.arguments || inner.args || inner.input };
  }

  if (
    type === 'tool_result' ||
    type === 'function_call_output' ||
    type === 'tool_output'
  ) {
    return {
      kind: 'tool_result',
      tool_use_id: inner.call_id || inner.tool_use_id || inner.id || '',
      isError: !!(inner.is_error || inner.error),
    };
  }

  // Agent text — 'agent_message', 'message', 'output_text', 'response.text'
  if (
    type === 'agent_message' ||
    type === 'message' ||
    type === 'output_text' ||
    type === 'response.output_text.delta' ||
    type === 'response.completed'
  ) {
    const text =
      (typeof inner.text === 'string' && inner.text) ||
      (typeof inner.content === 'string' && inner.content) ||
      (typeof inner.delta === 'string' && inner.delta) ||
      (Array.isArray(inner.content) &&
        inner.content
          .map((c) => (typeof c === 'string' ? c : c && c.text) || '')
          .filter(Boolean)
          .join(''));
    if (text && text.trim()) {
      return { kind: 'text', text };
    }
  }

  // Final result — codex emits a 'task_complete' or 'response.completed' event
  if (
    type === 'task_complete' ||
    type === 'session_complete' ||
    type === 'agent_session_complete' ||
    type === 'response.completed'
  ) {
    return {
      kind: 'result',
      result:
        inner.last_agent_message ||
        inner.message ||
        inner.text ||
        inner.output ||
        null,
      isError: !!inner.error,
    };
  }

  return null;
}

module.exports = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  binary: 'codex',
  installHint: 'npm i -g @openai/codex',
  needsMcpConfigFile: false,
  detect,
  build,
  classifyEvent,
};
