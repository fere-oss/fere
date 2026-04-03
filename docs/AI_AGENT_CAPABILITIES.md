# Sentinel Capabilities (Fere)

_Last updated: March 26, 2026_

This document describes the current Sentinel direction in Fere.

Sentinel is no longer positioned as an in-app general chatbot. That direction was too close to Codex and Claude while being less defensible. The useful direction is a local-first runtime operator: it watches the live stack, finds concrete failures and drift, ranks impact, and offers focused actions.

## Product Direction

### What Sentinel should be
- A deterministic runtime investigator for the local stack.
- A proactive watcher that notices health, dependency, and config drift in the background.
- A fast triage surface that points directly to the affected service and the next concrete action.

### What Sentinel should not be
- A generic code chat assistant.
- A long-form prompt box that expects the user to explain the whole problem.
- A prose-heavy summary tool that restates what the user already sees.

## Why This Is Useful Compared To Codex / Claude

Codex and Claude are strong when the user already knows what to ask and can provide the right context. Sentinel should win somewhere else:

- It sees the live topology, not just the codebase.
- It knows what is actually running, unhealthy, stopped, disconnected, or missing.
- It can rank blast radius from the real graph.
- It can keep watching in the background without the user writing a prompt.
- It can offer focused runtime fixes instead of broad generic advice.

The value is not "better answers." The value is better grounding.

## Current Shipped Capabilities

### 1) Deterministic Runtime Scan
Sentinel scans the live stack and returns structured findings with:
- severity
- category
- detail
- blast radius / affected services
- optional executable or copy-only fix

### 2) Runtime Checks Implemented
- Port conflict detection
- Down service detection
- Cascade impact detection
- Stopped container detection
- Unhealthy container detection
- Restart-loop detection
- Disconnected service detection
- Missing dependency detection from `package.json`
- Missing Docker healthcheck detection from compose files
- Env-var-to-runtime mismatch detection

### 3) Focused Fix Workflow
For each finding, Sentinel can:
- apply safe typed fixes where supported
- copy fix commands or templates
- focus the affected service in the graph
- dismiss findings from the current review session

### 4) Background Watch
Sentinel now runs as a lightweight background watcher:
- scans when the service topology changes
- rescans on an interval while the app is open
- surfaces new actionable findings discovered while the panel was closed
- marks new findings visually when the user opens the panel

This is the core proactive behavior that general coding assistants do not provide.

## Current UX Contract

The panel should remain:
- findings-first
- minimal
- action-oriented
- built into the app shell

The panel should avoid:
- chat history
- freeform conversation as the main interaction
- long markdown reports
- duplicated information that does not change the user’s next action

## Gaps That Still Matter

### 1) No incident memory yet
Sentinel does not yet keep a durable timeline of what changed and when a finding first appeared.

### 2) No verification loop after fix execution
Some fixes can be applied, but Sentinel does not yet force a post-fix verification cycle before marking the issue resolved.

### 3) No proactive notification layer yet
Sentinel marks new findings in the UI, but it does not yet escalate high-signal incidents through a stronger notification model.

### 4) No scoped investigation handoff yet
Sentinel can focus a service, but it does not yet open a deeper guided investigation path from a finding when deterministic checks are insufficient.

## Recommended Next Steps

### Highest-value product work
1. Add incident-change tracking (`new`, `worsened`, `resolved`).
2. Add stronger background escalation for critical findings.
3. Add verify-after-fix before clearing or downgrading an issue.
4. Add a narrow deep-investigation path only for findings that need more evidence.
5. Persist notable incidents so Sentinel becomes more useful over time.

### Guardrails for future AI work
If AI is reintroduced, it should only be used where deterministic checks are insufficient, for example:
- explaining why a multi-service failure pattern is happening
- proposing a fix plan after evidence has already been collected
- generating a targeted verification checklist

AI should not be the default surface.
