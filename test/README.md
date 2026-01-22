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

### Redis Mock (port 6379)

Simple TCP server to surface the "cache" service type.

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
