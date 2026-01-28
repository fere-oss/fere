#!/bin/bash

# Stop Docker test environment for Fere

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🛑 Stopping Fere Docker test environment..."

# Stop and remove containers
docker-compose down

echo ""
echo "✅ All containers stopped."
echo ""
echo "💡 To also remove volumes (database data): docker-compose down -v"
