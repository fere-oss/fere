# Docker Test Environment for Fere

This directory contains a Docker Compose setup to test Fere's container visualization feature.

## Architecture

```
                    ┌─────────────┐
                    │  Frontend   │ :3001
                    │   (nginx)   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ API Gateway │ :8080
                    │   (nginx)   │
                    └──────┬──────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
     ┌──────▼──────┐              ┌───────▼─────┐
     │User Service │ :5001        │Order Service│ :5002
     │  (Python)   │              │  (Node.js)  │
     └──────┬──────┘              └───────┬─────┘
            │                             │
     ┌──────┴─────┬───────────────┬───────┴──────┐
     │            │               │              │
┌────▼────┐ ┌─────▼─────┐  ┌──────▼─────┐ ┌──────▼──────┐
│  Redis  │ │ PostgreSQL│  │  RabbitMQ  │ │  MongoDB    │
│  :6380  │ │   :5433   │  │   :5673    │ │   :27018    │
└─────────┘ └───────────┘  └──────┬─────┘ └─────────────┘
                                  │
                           ┌──────▼──────┐
                           │Notification │
                           │   Worker    │
                           └─────────────┘
```

## Quick Start

```bash
# Start all containers
docker-compose up -d

# View running containers
docker-compose ps

# View logs
docker-compose logs -f

# Stop all containers
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

## Services

| Service             | Port  | Type      | Description                    |
|---------------------|-------|-----------|--------------------------------|
| frontend            | 4001  | Frontend  | Nginx serving React app        |
| api-gateway         | 8080  | Gateway   | API Gateway / Load Balancer    |
| user-service        | 5001  | Backend   | Python Flask user auth API     |
| order-service       | 5002  | Backend   | Node.js order processing API   |
| notification-service| -     | Worker    | Background notification worker |
| postgres            | 5433  | Database  | PostgreSQL database            |
| redis               | 6380  | Cache     | Redis cache                    |
| rabbitmq            | 5673  | Queue     | RabbitMQ message broker        |
| mongodb             | 27018 | Database  | MongoDB document store         |
| elasticsearch       | 9201  | Search    | Elasticsearch search engine    |

## Networks

- `fere-frontend` - Frontend to gateway communication
- `fere-backend` - Backend service communication
- `fere-database` - Database access network
- `fere-queue` - Message queue network

## Testing Endpoints

```bash
# Frontend
curl http://localhost:4001

# API Gateway
curl http://localhost:8080

# User Service
curl http://localhost:5001/health
curl http://localhost:5001/api/users

# Order Service
curl http://localhost:5002/health
curl http://localhost:5002/api/orders

# RabbitMQ Management UI
open http://localhost:15673  # guest:guest
```

## Docker Commands for Visualization Testing

```bash
# List all containers
docker ps -a

# List networks
docker network ls

# Inspect a network (shows connected containers)
docker network inspect fere-backend

# Get container stats
docker stats --no-stream

# Inspect container
docker inspect fere-test-postgres
```

## Labels for Fere

Each container includes `fere.*` labels for testing:
- `fere.type` - Service type (frontend, backend, database, cache, queue, worker, search)
- `fere.description` - Human-readable description

These can be read via:
```bash
docker inspect --format='{{json .Config.Labels}}' fere-test-postgres
```
