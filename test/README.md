# Fere Test Services

Test servers for developing and testing the Fere dashboard.

## Quick Start

```bash
# Start all services at once
./start-all.sh

# Or start individually:
python3 server.py      # Flask API on port 5001
node node-server.js    # Node server on port 3001
./redis-server-mock    # Redis mock on port 6379
./docker-mock          # Docker mock on port 2375
./bun-mock.rb          # Service mock on port 7070 (requires Ruby)
node external-connector.js # External connector (outbound)
node broker-mock.js    # Broker mock on port 4222
node ws-server-mock.js # WS mock server on port 8081
node ws-client-mock.js # WS mock client (outbound)
node http-client-mock.js # HTTP client mock (outbound)
node postgres-client-mock.js # Postgres client mock (outbound)
node worker-mock.js    # Background worker (no port)
```

## Services

### Flask API Server (port 5001)

A full-featured REST API with:
- CRUD endpoints (`/api/items`)
- SQLite database integration (`/api/metrics`, `/api/logs`)
- Server-Sent Events (`/api/events/stream`)
- Test endpoints (`/api/slow`, `/api/error`)

### Node.js Server (port 3001)

A simple HTTP server simulating a frontend proxy:
- Health checks
- Request statistics
- Proxy simulation to Flask API
- Keeps persistent TCP connections to Flask/Redis/Docker/Service mocks to surface edges

### Redis Mock (port 6379)

Simple TCP server to surface the "cache" service type.
Keeps sockets open so edges remain visible.

### Broker Mock (port 4222)

Simple TCP server to surface a message broker service.

### WS Mock Server (port 8081)

TCP server that holds open connections for real-time edge testing.

### WS Mock Client (outbound)

Connects to the WS mock server to keep a live edge visible.

### HTTP Client Mock (outbound)

Periodically hits the Node and Flask health endpoints.

### Postgres Client Mock (outbound)

Holds a TCP connection open to port 5432 for DB edge testing.

### Worker Mock (no port)

Background process to validate nodes without listening ports.

### Docker Mock (port 2375)

Simple HTTP server to surface the "container" service type.

### Service Mock (port 7070)

Ruby TCP server to surface the generic "service" type (shown in red).

### External Connector (outbound)

Keeps a TCP connection open to `example.com:443` so the external node appears in the sidebar.

## Testing the Dashboard

1. Start the test services: `./start-all.sh`
2. Start Fere: `npm run electron:dev`
3. You should see all services appear in the dashboard with their ports

## Endpoints Reference

### Flask API (localhost:5001)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info |
| GET | `/health` | Health check |
| GET | `/status` | Server status |
| GET | `/api/items` | List items |
| POST | `/api/items` | Create item |
| GET | `/api/items/:id` | Get item |
| PUT | `/api/items/:id` | Update item |
| DELETE | `/api/items/:id` | Delete item |
| GET | `/api/metrics` | Get metrics |
| POST | `/api/metrics` | Record metric |
| GET | `/api/logs` | Get logs |
| POST | `/api/logs` | Create log |
| GET | `/api/events/stream` | SSE stream |
| POST | `/api/events` | Push event |
| GET | `/api/db/stats` | Database stats |
| GET | `/api/slow?delay=N` | Slow endpoint |
| GET | `/api/error?type=N` | Error endpoint |

### Node Server (localhost:3001)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Server info |
| GET | `/health` | Health check |
| GET | `/stats` | Request stats |
| GET | `/proxy/*` | Proxy to Flask |
