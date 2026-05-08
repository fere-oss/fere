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
// Current shape (codex-cli 0.121+): top-level events like
//   { type: 'thread.started', ... }
//   { type: 'turn.started' }
//   { type: 'item.started', item: { type: 'message_output' | 'tool_call' | ... } }
//   { type: 'item.completed', item: { ... } }
//   { type: 'turn.completed', usage: {...} }
//   { type: 'turn.failed', error: { message } }
//   { type: 'error', message }
// Older variants used { msg: { type, ... } }. We try both.
function classifyEvent(event) {
  if (!event || typeof event !== 'object') return null;

  const topType = event.type;
  const inner = event.msg || event.item || event;
  const innerType = inner.type || topType;

  // Hard error events — codex emits a top-level `{type: 'error', message}` or
  // `{type: 'turn.failed', error: {message}}` and then exits.
  if (topType === 'error') {
    return { kind: 'result', result: extractErrorMessage(event), isError: true };
  }
  if (topType === 'turn.failed') {
    return { kind: 'result', result: extractErrorMessage(event.error || event), isError: true };
  }

  // Item-style events (codex >= 0.100): wrap a tool_call / message_output / etc.
  if (topType === 'item.started' || topType === 'item.completed' || topType === 'item.updated') {
    const item = event.item || {};
    const itemType = item.type;

    if (itemType === 'tool_call' || itemType === 'mcp_tool_call' || itemType === 'function_call') {
      const tool =
        item.tool ||
        item.name ||
        item.tool_name ||
        (item.function && item.function.name) ||
        'tool';
      // Only emit on start so we don't double-emit on completed
      if (topType !== 'item.started') return null;
      return { kind: 'tool_use', tool, input: item.arguments || item.args || item.input };
    }

    if (itemType === 'message_output' || itemType === 'agent_message' || itemType === 'message') {
      const text = extractText(item);
      if (text) return { kind: 'text', text };
    }

    return null;
  }

  // Successful turn end — surface the last agent message if present
  if (topType === 'turn.completed' || innerType === 'task_complete' || innerType === 'session_complete') {
    return {
      kind: 'result',
      result:
        event.last_agent_message ||
        inner.last_agent_message ||
        inner.message ||
        inner.text ||
        inner.output ||
        null,
      isError: false,
    };
  }

  // Older / alternate flat shapes
  if (
    innerType === 'tool_call' ||
    innerType === 'function_call' ||
    innerType === 'mcp_tool_call' ||
    innerType === 'tool_use'
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
    innerType === 'tool_result' ||
    innerType === 'function_call_output' ||
    innerType === 'tool_output'
  ) {
    return {
      kind: 'tool_result',
      tool_use_id: inner.call_id || inner.tool_use_id || inner.id || '',
      isError: !!(inner.is_error || inner.error),
    };
  }

  if (
    innerType === 'agent_message' ||
    innerType === 'message' ||
    innerType === 'output_text' ||
    innerType === 'response.output_text.delta' ||
    innerType === 'response.completed'
  ) {
    const text = extractText(inner);
    if (text) return { kind: 'text', text };
  }

  return null;
}

function extractText(payload) {
  if (!payload) return '';
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text;
  if (typeof payload.content === 'string' && payload.content.trim()) return payload.content;
  if (typeof payload.delta === 'string' && payload.delta.trim()) return payload.delta;
  if (Array.isArray(payload.content)) {
    const joined = payload.content
      .map((c) => (typeof c === 'string' ? c : (c && c.text) || ''))
      .filter(Boolean)
      .join('');
    if (joined.trim()) return joined;
  }
  return '';
}

// Codex error events sometimes nest a stringified JSON inside `message` —
// pull out the human-readable message if so.
function extractErrorMessage(payload) {
  if (!payload) return null;
  const raw = payload.message || payload.error || payload.text || null;
  if (typeof raw !== 'string') return raw || null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.error && parsed.error.message) return parsed.error.message;
    if (parsed && parsed.message) return parsed.message;
  } catch { /* not nested JSON */ }
  return raw;
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
