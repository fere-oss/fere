# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [2.0.0] — 2026-05-04

### Added

- **Sentinel** — unified runtime operator surface replacing the old Ask Fere + debugger split.
  Deterministic, local-first checks run before any AI layer; findings are ranked by severity and blast radius.
- Full-stack scan scope (not tab-scoped) with background rescans on topology change and on interval.
- Unread/new-finding signaling for proactive surface.
- `electron/handlers/` — IPC handler groups extracted from `main.js` for maintainability.
- `src/components/agent/` — AgentPanel split into focused sub-components.
- `electron/services/` reorganised into domain subdirectories (`monitoring/`, `discovery/`, `docker/`, `graph/`, `ai/`, `system/`, `sharing/`, `database/`).
- `electron/constants.js` — centralised magic numbers (auth refresh interval, Sentinel daily limit, callback port).
- `src/constants/tabs.ts`, `src/utils/formatting.ts`, `src/utils/stackDetection.ts`, `src/components/DockerEmptyState.tsx` — extracted from `App.tsx`.
- `.env.example` documenting all optional environment variables.
- `electron/runtime-config.example.json` — template for local Supabase config.
- GitHub Actions CI (`ci.yml`) and release workflow (`release.yml`).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue templates, and PR template.

### Changed

- `electron/services/fereAgent.js` renamed to `electron/services/ai/sentinelEngine.js`.
- PostHog API key externalised to `POSTHOG_API_KEY` / `REACT_APP_POSTHOG_API_KEY` env vars; analytics is a no-op when the key is absent.
- `electron/runtime-config.json` added to `.gitignore`.
- All empty `catch {}` blocks annotated with comments.
- Docs standardised: consistent heading hierarchy, sentence-case headers, no orphaned TODOs.

### Removed

- `docs/fere-agent-plan.md` and `docs/monetization-auth-plan.md` (internal strategy documents).
