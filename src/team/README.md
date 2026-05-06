# Team tier — renderer features

Team features live here. They are gated behind `REACT_APP_FERE_TEAM_MODE=true` and require a cloud backend.

This directory is a stub in the open-source release. It is intentionally empty.

## Enabling

Set `REACT_APP_FERE_TEAM_MODE=true` in your `.env` file. Features in this directory activate only when that flag is present and a valid Team subscription is associated with the authenticated account.

## What belongs here

- Shared topology views (multi-user session state)
- Team incident feed and shared annotations
- Cloud snapshot sync and history
- Role-based access controls for fix actions

## What does not belong here

Core features — service map, Sentinel, Docker monitoring, API tester, database explorer — are free and open. They live in `src/components/` and `src/hooks/` with no feature flag. Keep them there.
