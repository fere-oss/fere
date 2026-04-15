# Fere — Audience Definition

## Primary Audience

Local developers who want to see what's running on their laptop that isn't in the cloud.

Every engineer has observability for production — Datadog, Grafana, Sentry, CloudWatch. Nobody has observability for localhost. The moment your laptop runs more than one service, you lose the thread: what's on port 5432 today, which container crashed overnight, why is the frontend hitting the wrong backend, what's still holding that port from yesterday's session.

Fere is the missing observability layer for the machine under your desk. "Datadog for localhost."

This spans from students hitting their second service for the first time, to senior engineers running ten containers across three projects. The common thread is the same: localhost got complicated, and there's no tool for it.

## Activation Moment

The inflection point is when a developer's local environment crosses from "one process I can hold in my head" to "multiple services I can't." Typically this is:

- Adding Docker to a project for the first time
- Splitting a monolith into a frontend + backend + database
- Pulling a microservice repo with five+ services in docker-compose
- Joining a team whose local stack takes 20 minutes to orient to every morning

Onboarding copy should hit this moment. Audience targeting should not be scoped to it.

## Secondary Audience

Small startup teams (2-8 engineers) running microservice-heavy local stacks. Full-stack engineers who own their whole stack and lose 20-30 minutes orienting themselves before they can start debugging. These users amplify the viral mechanism — they have teammates to share snapshots into.

## Not a Fit

- Large enterprise teams with locked-down machines and mandated tooling
- Frontend-only engineers who never touch backend services
- Engineers working on a single monolith with no service dependencies
- Pure cloud-native teams who develop entirely in remote environments (Codespaces, Gitpod)

## Viral Mechanism

The shareable HTML snapshot export is the key distribution lever. One engineer exports their local topology, shares it in a Slack thread or PR. Teammates see it, ask "what tool is this?", and adopt Fere. The snapshot is the product demo.

This mechanism requires a team to share into — which is why the primary ICP is working developers, not students. Students consume tools; working devs spread them.

## Positioning Line

> Observability for the machine under your desk.

Alt:

> Datadog shows you prod. Fere shows you localhost.
