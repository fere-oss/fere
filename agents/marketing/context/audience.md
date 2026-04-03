# Fere — Audience Definition

## Primary Audience

Students and junior developers who want to understand what is happening in their local dev environment.

The key moment: the inflection point when they first add Docker or a second service to their project. Suddenly their mental model breaks. They have a frontend talking to a backend talking to a database, and they can't see the connections anymore. Fere makes the invisible visible.

These users don't have deep systems knowledge yet. They need a tool that shows them what's running, what's connected to what, and what's healthy — without requiring them to know the right `lsof` flags or Docker networking internals.

## Secondary Audience

Small startup teams (2-8 engineers) running microservice-heavy local stacks. Full-stack engineers who own their whole stack and lose 20-30 minutes orienting themselves before they can start debugging.

For these users, the value is speed. They already understand their stack conceptually, but they waste time every morning figuring out what's running, what's crashed, and what port something is on today.

## Not a Fit

- Large enterprise teams with existing observability stacks (Datadog, Grafana, etc.)
- Frontend-only engineers who never touch backend services
- Engineers working on a single monolith with no service dependencies

## Viral Mechanism

The shareable HTML snapshot export is the key distribution lever. One engineer exports their local topology, shares it with their team in Slack or a PR. The team sees it, asks "what tool is this?", and adopts Fere. The snapshot is the product demo.
