#!/bin/bash
#
# Start all test services for Fere Dashboard testing
#
# This script starts:
#   - Flask API server on port 5001
#   - Node.js server on port 3001
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

# Install Flask if needed
if ! python3 -c "import flask" 2>/dev/null; then
    echo -e "${YELLOW}Installing Flask...${NC}"
    pip3 install flask --quiet
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

echo -e "\n${GREEN}All services started!${NC}"
echo -e "  Flask API:  http://localhost:5001"
echo -e "  Node.js:    http://localhost:3001"
echo -e "\n${YELLOW}Press Ctrl+C to stop all services${NC}\n"

# Wait for all background processes
wait
