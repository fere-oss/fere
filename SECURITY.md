# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Fere, please report it responsibly.

**Email:** security@fere.dev (or open a private GitHub security advisory)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment (what an attacker could achieve)

We will acknowledge reports within 48 hours and aim to release a fix within 7 days for critical issues.

**Do not** open public GitHub issues for security vulnerabilities.

## Security Model

### Electron Hardening

Fere follows Electron security best practices:

- **Context isolation** enabled (`contextIsolation: true`)
- **Node integration** disabled in the renderer (`nodeIntegration: false`)
- **Renderer sandbox** enabled (`sandbox: true`)
- **Navigation blocking** prevents the renderer from navigating to untrusted origins
- **Window open handler** denies new Electron windows; external links open in the system browser
- **Permission handler** denies all permission requests by default (except clipboard)
- **Content Security Policy** applied via response headers (strict in production, relaxed for HMR in dev)

All privileged operations (process listing, port scanning, Docker, database access, HTTP requests) are gated behind IPC handlers in the main process. The renderer communicates exclusively through `window.electronAPI` exposed via the preload bridge.

### HTTP Request Security

The in-app API tester includes:

- **SSRF protection** — private/internal IP ranges (RFC 1918, loopback, link-local, carrier-grade NAT) are blocked by default when the network policy is set to "public"
- **Protocol restriction** — only `http:` and `https:` are allowed; `file:`, `javascript:`, `data:`, and other dangerous protocols are blocked
- **Response size cap** — responses larger than 10 MB are rejected to prevent memory abuse
- **Request timeout** — 30-second timeout on all outbound requests
- **Network policy toggle** — users can switch between "local" (allow private networks, the default for local dev) and "public" (block private networks) via the UI, persisted in `~/.fere/settings.json`

### Request History Redaction

Request history persisted to `~/.fere/request-history.json` is automatically redacted before writing:

- **Sensitive headers** (`Authorization`, `Cookie`, `X-API-Key`, etc.) have their values replaced with `[REDACTED]`
- **Sensitive body fields** (`password`, `token`, `api_key`, `client_secret`, etc.) are redacted in both JSON and form-encoded bodies
- **Retention limits** — maximum 100 entries, entries older than 30 days are pruned on load

### OS Command Execution

Fere runs `ps` and `lsof` to enumerate processes, ports, and TCP connections. These commands are executed with the user's own permissions and read only — no system state is modified. Docker CLI commands (`docker ps`, `docker inspect`, `docker logs`, etc.) are used only when Docker Desktop is running.

### Source Code Scanning

Route discovery and external API detection scan project source files and `.env` files on disk. Scanning is read-only. Detected data (routes, API provider matches) is held in memory with short-lived TTL caches and is not persisted to disk or transmitted externally.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Scope

The following are **in scope** for security reports:

- Remote code execution via the renderer or main process
- IPC handler bypasses (accessing privileged operations without proper validation)
- SSRF bypasses in the HTTP request handler
- Credential/token leakage to disk or network
- Electron hardening regressions (CSP bypass, sandbox escape, navigation bypass)
- Path traversal or command injection in service modules

The following are **out of scope**:

- Local privilege escalation (Fere runs with the user's own permissions by design)
- Denial of service against the local app
- Issues requiring physical access to the machine
