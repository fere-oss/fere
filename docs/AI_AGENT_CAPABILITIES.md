# AI Agent Capabilities (Fere)

_Last updated: March 13, 2026_

This document summarizes what the in-app Fere AI Debug Agent can do today, and what it can do next with additional implementation.

## What The Agent Can Do Right Now

### 1) Investigate Runtime Issues
- Start investigations from a natural-language problem statement.
- Continue investigations with follow-up prompts.
- Resume context from recent chat history after restart (limited window).
- Stream investigation progress step-by-step in the UI.

### 2) Execute HTTP Probes
- Send one request (`fire_request`) with method, headers, and body.
- Send concurrent requests (`fire_concurrent_requests`) to check intermittent behavior.
- Capture status, headers, body excerpt, latency, and size.

### 3) Collect Logs Across Environments
- Read Docker container logs (`get_container_logs`).
- Fall back to local host-service logs when Docker is unavailable (`get_local_service_logs`).
- Filter by time range, tail size, and text grep.

### 4) Read And Search Source Code
- Read specific files/line ranges (`read_source_file`).
- Find files by glob (`find_source_files`).
- Search code by regex/text (`grep_source`).
- Retrieve discovered service routes (`get_service_routes`).

### 5) Run Safe Verification Commands
- Execute allowlisted project commands (`run_project_command`) for verification, such as:
  - `npm/pnpm/yarn` test/lint/build
  - `pytest`, `go test`, `cargo test`, `npx vitest`, `bun test`
- Return stdout/stderr excerpts and pass/fail status.

### 6) Apply Targeted Code Edits
- Apply controlled in-file text replacements (`apply_source_edit`) within service project boundaries.
- Supports single or replace-all operations.
- Enforces path safety and reports replacement counts.

### 7) Database Debug Queries
- Run read-only SQL statements (`run_database_query`) against detected DB containers.
- Restricts to read operations and blocks multi-statement writes.

### 8) Produce Structured Final Reports
- Final output is guided to markdown sections:
  - Diagnosis
  - Root Cause
  - Evidence
  - Affected Services
  - Fix Applied
  - Verification
  - Rollback
  - Confidence
- Includes a forced final synthesis path when iteration budget is exhausted.

### 9) Stability / UX Guardrails Implemented
- Rate-limit handling with retry delay parsing for OpenAI 429 responses.
- Smaller token budgets and context trimming to reduce runaway TPM usage.
- Loop detection for repeated identical tool calls.
- Conversation history seed for restart continuity.

---

## Current Constraints

- Code edits are currently text-replacement based, not AST-aware.
- Verification command execution is allowlist-limited.
- History resume seeds only recent prompt/response turns, not full prior tool-result graph.
- The agent can still be overconfident if evidence is weak (improved, not eliminated).
- Syntax highlighting depends on fenced code formatting and language detectability.

---

## What More The Agent Can Do Next

## A) Reliability Upgrades (Highest Priority)
- Machine-verified completion contract:
  - Block “Fix Applied” claims unless an edit tool succeeded.
  - Auto-attach “Changed files” from executed tool events.
- Mandatory verify-before-done:
  - Require at least one rerun request/test after edits.
- Confidence gating:
  - Downgrade confidence automatically when evidence is missing.

## B) Stronger Editing Capabilities
- Add append/create file tools (safe-scoped).
- Add multi-file patch tool with dry-run preview.
- Add AST-aware transforms for TypeScript/Python to reduce fragile string replacements.

## C) Better Reproduction And Auth Handling
- Built-in auth/session helpers for 307/401/403 workflows.
- Scenario runner:
  - Run N attempts with payload variants and summarize failure clusters.

## D) Better Performance At Scale
- Virtualized chat-turn rendering for very long histories.
- Smarter per-turn context packing (evidence graph instead of raw tool text).
- Model routing:
  - Cheap model for discovery, stronger model only for final diagnosis/fix plan.

## E) Higher-Trust Developer Workflow
- “Plan -> Apply -> Verify” mode with explicit checkpoints.
- Auto-generate rollback scripts for changed files.
- One-click open changed files in editor with line anchors.

## F) Team / Governance Features
- Persist investigations to shareable incident reports.
- Optional approval gates before edit execution.
- Policy profiles (strict read-only vs operator mode).

---

## Recommended Near-Term Roadmap

1. Verified completion contract (no unverified “Fix Applied”).
2. Post-edit mandatory verification step.
3. Virtualized long-chat UI rendering.
4. Add append/create file tool.
5. Add AST-aware edit primitives for TS/Python.

These five changes would give the largest jump in practical trust and day-to-day usefulness.
