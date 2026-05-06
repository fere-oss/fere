# Team tier — main-process handlers and cloud sync

Team-tier IPC handlers and cloud sync services live here. They require `FERE_TEAM_MODE=true` and a cloud backend.

This directory is a stub in the open-source release. It is intentionally empty.

## Enabling

Set `FERE_TEAM_MODE=true` in your environment. Handlers in this directory are registered in `electron/main.js` only when the flag is present.

## What belongs here

- Cloud sync service (snapshot upload, remote incident state)
- Collaboration presence handlers (active users, live cursors)
- Team-scoped auth token refresh and session management
- Org-tier policy enforcement (network allow-lists, audit log push)

## What does not belong here

Core IPC handlers — monitoring, Docker, database, Sentinel scan, API requests — are free and open. They live in `electron/handlers/` with no feature flag.
