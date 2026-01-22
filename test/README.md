# Fere Test Services

Test servers for developing and testing the Fere dashboard.

## Quick Start

```bash
# Start all services at once
./start-all.sh

# Or start individually:
python3 server.py      # Flask API on port 5001
node node-server.js    # Node server on port 3001
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

## Testing the Dashboard

1. Start the test services: `./start-all.sh`
2. Start Fere: `npm run electron:dev`
3. You should see both services appear in the dashboard with their ports

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
