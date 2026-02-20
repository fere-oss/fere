#!/bin/bash
#
# Start all test services for Fere Dashboard testing
#
# This script starts:
#   - Flask API server on port 5001
#   - Node.js server on port 3001
#   - Redis mock server on port 6379
#   - Docker mock server on port 2375
#   - Service mock (Ruby) on port 7070
#   - External connector (outbound) to example.com:443
#   - Broker mock server on port 4222
#   - WS mock server on port 8081 + client
#   - HTTP client mock (outbound)
#   - Postgres client mock (outbound)
#   - Worker mock (no port)
#   - Go API server (Gin) on port 8082
#   - Fiber API server (Go Fiber) on port 8084
#   - Django API server on port 8091
#   - Rails API server (WEBrick) on port 8092
#
# Usage: ./start-all.sh
# Stop all: Ctrl+C (will stop all background processes)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║              Fere Test Services Launcher                      ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Track PIDs for cleanup
PIDS=()

cleanup() {
    echo -e "\n${YELLOW}Shutting down test services...${NC}"
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    # Also clean up any orphaned processes
    pkill -f "python.*server.py" 2>/dev/null || true
    pkill -f "node.*node-server.js" 2>/dev/null || true
    pkill -f "go-server" 2>/dev/null || true
    pkill -f "fiber-server" 2>/dev/null || true
    pkill -f "manage.py.*runserver" 2>/dev/null || true
    pkill -f "rails-server.rb" 2>/dev/null || true
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: python3 not found${NC}"
    exit 1
fi

# Check for Node
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: node not found${NC}"
    exit 1
fi

# Check for Ruby (optional)
if ! command -v ruby &> /dev/null; then
    echo -e "${YELLOW}Warning: ruby not found, skipping service mock and Rails server${NC}"
    HAS_RUBY=false
else
    HAS_RUBY=true
fi

# Check for Go (optional)
if ! command -v go &> /dev/null; then
    echo -e "${YELLOW}Warning: go not found, skipping Go servers (Gin, Fiber)${NC}"
    HAS_GO=false
else
    HAS_GO=true
fi

# Install Flask if needed
if ! python3 -c "import flask" 2>/dev/null; then
    echo -e "${YELLOW}Installing Flask...${NC}"
    pip3 install flask --quiet
fi

# Install Django if needed
if ! python3 -c "import django" 2>/dev/null; then
    echo -e "${YELLOW}Installing Django...${NC}"
    pip3 install django --quiet
fi

# Start Flask server
echo -e "${GREEN}Starting Flask API server on port 5001...${NC}"
python3 server.py &
PIDS+=($!)
sleep 1

# Start Node server
echo -e "${GREEN}Starting Node.js server on port 3001...${NC}"
node node-server.js &
PIDS+=($!)
sleep 1

# Start Redis mock server
echo -e "${GREEN}Starting Redis mock server on port 6379...${NC}"
./redis-server-mock &
PIDS+=($!)
sleep 1

# Start Docker mock server
echo -e "${GREEN}Starting Docker mock server on port 2375...${NC}"
./docker-mock &
PIDS+=($!)
sleep 1

# Start Service mock server (Ruby)
if [ "$HAS_RUBY" = true ]; then
    echo -e "${GREEN}Starting Service mock server on port 7070...${NC}"
    ./bun-mock.rb &
    PIDS+=($!)
    sleep 1
fi

# Start External connector
echo -e "${GREEN}Starting External connector to example.com:443...${NC}"
node external-connector.js &
PIDS+=($!)
sleep 1

# Start Broker mock server
echo -e "${GREEN}Starting Broker mock server on port 4222...${NC}"
node broker-mock.js &
PIDS+=($!)
sleep 1

# Start WS mock server
echo -e "${GREEN}Starting WS mock server on port 8081...${NC}"
node ws-server-mock.js &
PIDS+=($!)
sleep 1

# Start WS mock client
echo -e "${GREEN}Starting WS mock client...${NC}"
node ws-client-mock.js &
PIDS+=($!)
sleep 1

# Start HTTP client mock
echo -e "${GREEN}Starting HTTP client mock...${NC}"
node http-client-mock.js &
PIDS+=($!)
sleep 1

# Start Postgres client mock
echo -e "${GREEN}Starting Postgres client mock...${NC}"
node postgres-client-mock.js &
PIDS+=($!)
sleep 1

# Start Worker mock
echo -e "${GREEN}Starting Worker mock...${NC}"
node worker-mock.js &
PIDS+=($!)
sleep 1

# Start Go server (Gin)
if [ "$HAS_GO" = true ]; then
    echo -e "${GREEN}Starting Go API server (Gin) on port 8082...${NC}"
    (cd "$SCRIPT_DIR/go-server" && go mod tidy -e 2>/dev/null; go run .) &
    PIDS+=($!)
    sleep 2
fi

# Start Fiber server (Go Fiber)
if [ "$HAS_GO" = true ]; then
    echo -e "${GREEN}Starting Fiber API server on port 8084...${NC}"
    (cd "$SCRIPT_DIR/fiber-server" && go mod tidy -e 2>/dev/null; go run .) &
    PIDS+=($!)
    sleep 2
fi

# Start Django server
echo -e "${GREEN}Starting Django API server on port 8083...${NC}"
(cd "$SCRIPT_DIR/django-server" && python3 manage.py runserver 0.0.0.0:8091 --noreload) &
PIDS+=($!)
sleep 2

# Start Rails server (WEBrick)
if [ "$HAS_RUBY" = true ]; then
    echo -e "${GREEN}Starting Rails API server on port 8092...${NC}"
    (cd "$SCRIPT_DIR/rails-server" && ruby rails-server.rb) &
    PIDS+=($!)
    sleep 1
fi

echo -e "\n${GREEN}All services started!${NC}"
echo -e "  Flask API:       http://localhost:5001"
echo -e "  Node.js:         http://localhost:3001"
echo -e "  Redis mock:      tcp://localhost:6379"
echo -e "  Docker mock:     http://localhost:2375"
if [ "$HAS_RUBY" = true ]; then
    echo -e "  Service mock:    tcp://localhost:7070"
fi
echo -e "  External connector: example.com:443"
echo -e "  Broker mock:     tcp://localhost:4222"
echo -e "  WS mock:         tcp://localhost:8081"
echo -e "  HTTP client mock: outbound"
echo -e "  Postgres client mock: outbound"
echo -e "  Worker mock:     background"
if [ "$HAS_GO" = true ]; then
    echo -e "  Go API (Gin):    http://localhost:8082"
    echo -e "  Fiber API:       http://localhost:8084"
fi
echo -e "  Django API:      http://localhost:8091"
if [ "$HAS_RUBY" = true ]; then
    echo -e "  Rails API:       http://localhost:8092"
fi
echo -e "\n${YELLOW}Press Ctrl+C to stop all services${NC}\n"

# Wait for all background processes
wait
