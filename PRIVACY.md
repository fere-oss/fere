# Privacy Policy

**Last updated:** 2025-02-19

Fere is a local-first macOS desktop application. This document describes what data Fere collects, where it is stored, and how it is used.

## Data Collected Locally

Fere monitors your local development environment by running standard macOS commands (`ps`, `lsof`) and Docker CLI commands. All collected data stays on your machine unless explicitly noted below.

### Process and Network Data

Fere periodically enumerates running processes, listening ports, and established TCP connections to build the service topology graph. This data is held in memory only (with short-lived caches) and is never written to disk or transmitted externally.

**Data includes:** PIDs, process names, command-line arguments, CPU/memory usage, port numbers, and local/remote IP addresses of TCP connections.

### Source Code Scanning

Fere scans project source files and `.env` files on disk to discover API routes and detect external API usage. Scanning is read-only. Results are cached in memory (1-2 minute TTL) and are not persisted to disk or sent externally.

**Data includes:** File paths, detected API route patterns, matched API provider names, and environment variable keys (not values, except for URL-pattern matching).

### Docker and Container Data

When Docker Desktop is running, Fere queries container metadata, network topology, resource usage, and (on user request) container logs. This data is held in memory only.

### Request History

When you use the API tester, executed requests are saved to `~/.fere/request-history.json` for replay convenience. Before writing to disk:

- **Sensitive headers** are redacted: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token`, `X-CSRF-Token`, `X-XSRF-Token`
- **Sensitive body fields** are redacted in JSON and form-encoded payloads: `password`, `token`, `access_token`, `refresh_token`, `api_key`, `client_secret`, `private_key`, `credentials`, and others
- **Retention:** Maximum 100 entries; entries older than 30 days are pruned automatically

You can clear all request history at any time from the History tab in the API tester.

### Settings

User preferences are stored in `~/.fere/settings.json`. This currently includes:

- `alertsEnabled` — whether native crash/recovery notifications are shown
- `networkPolicy` — whether the HTTP client allows requests to private/local networks (`"local"`) or restricts to public targets only (`"public"`)

### API Provider Overrides

An optional file at `~/.fere/api-providers.json` lets you extend the built-in external API provider catalog. This file is user-created and user-managed.

## Data Transmitted Externally

### Product Analytics

Fere sends anonymous usage analytics to [PostHog](https://posthog.com) (`us.i.posthog.com`) to understand how the app is used and prioritize improvements.

**What is sent:**

| Event | Properties |
|-------|-----------|
| `app_launched` | `is_dev` (boolean) |
| `app_opened` | (none) |
| `tab_switched` | `to` (tab name) |
| `process_killed` | `success` (boolean) |
| `http_request_executed` | `method`, `status`, `duration`, `success` |
| `database_query_executed` | (query type metadata) |
| `database_connected` | `db_type`, `mode`, `success` |
| `container_logs_started` | (none) |

**Identification:** A device identifier is derived by hashing (`SHA-256`, truncated to 16 characters) the machine's hostname, username, platform, and architecture. No plaintext PII is transmitted.

**What is NOT sent:** file contents, source code, environment variable values, request/response bodies, database query results, container logs, or IP addresses of your services.

### Logo Assets

The UI may load service logos from `img.logo.dev` for visual display in the service graph.

### No Other External Communication

Fere does not phone home for update checks, license validation, or crash reporting. The only outbound network calls are the analytics events above, logo asset requests, and HTTP requests you explicitly initiate via the API tester.

## Data Deletion

To remove all data Fere has stored locally:

```bash
rm -rf ~/.fere
```

Analytics data already sent to PostHog can be deleted by contacting us.

## Changes to This Policy

We will update this document when data practices change. The "Last updated" date at the top reflects the most recent revision.
