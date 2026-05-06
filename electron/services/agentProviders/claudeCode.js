/**
 * Claude Code provider — headless `claude -p` with MCP config file.
 *
 * Stream format: stream-json (newline-delimited JSON), one event per line.
 * Each event is shaped like:
 *   { type: 'system'|'assistant'|'user'|'result', ... }
 *
 * Allowed tools: explicit allowlist passed via --allowedTools, restricted to
 * the Fere MCP tool surface plus Read/Grep/Glob.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveBinary } = require('./_resolveBinary');

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

async function detect() {
  try {
    await execFileP(resolveBinary('claude'), ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function build({ prompt, mcpConfigPath, cwd }) {
  return {
    command: resolveBinary('claude'),
    args: [
      '-p', prompt,
      '--mcp-config', mcpConfigPath,
      '--allowedTools', ALLOWED_TOOLS.join(','),
      '--output-format', 'stream-json',
      '--verbose',
    ],
    cwd,
    env: process.env,
  };
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

module.exports = {
  id: 'claude-code',
  displayName: 'Claude Code',
  binary: 'claude',
  installHint: 'npm i -g @anthropic-ai/claude-code',
  needsMcpConfigFile: true,
  detect,
  build,
  classifyEvent,
};
