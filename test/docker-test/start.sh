#!/bin/bash

# Start Docker test environment for Fere

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🐳 Starting Fere Docker test environment..."
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop first."
    exit 1
fi

# Pull images first (optional, for faster startup)
echo "📦 Pulling Docker images..."
docker-compose pull

# Start containers
echo ""
echo "🚀 Starting containers..."
docker-compose up -d

# Wait for services to be healthy
echo ""
echo "⏳ Waiting for services to be ready..."
sleep 5

# Show status
echo ""
echo "✅ Docker test environment is running!"
echo ""
docker-compose ps

echo ""
echo "📊 Container stats:"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"

echo ""
echo "🔗 Service URLs:"
echo "   Frontend:      http://localhost:4001"
echo "   API Gateway:   http://localhost:8080"
echo "   User Service:  http://localhost:5001/health"
echo "   Order Service: http://localhost:5002/health"
echo "   RabbitMQ UI:   http://localhost:15673 (guest:guest)"
echo ""
echo "🛑 To stop: ./stop.sh or docker-compose down"
