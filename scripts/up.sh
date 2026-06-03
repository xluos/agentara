#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$PROJECT_DIR/.run"
LOG_DIR="$PROJECT_DIR/.run/logs"

mkdir -p "$RUN_DIR" "$LOG_DIR"

# Check if either process is already running
server_running=false
web_running=false

if [ -f "$RUN_DIR/server.pid" ] && kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null; then
  server_running=true
fi
if [ -f "$RUN_DIR/web.pid" ] && kill -0 "$(cat "$RUN_DIR/web.pid")" 2>/dev/null; then
  web_running=true
fi

if [ "$server_running" = true ] || [ "$web_running" = true ]; then
  echo "Agentara is already running:"
  [ "$server_running" = true ] && echo "  server PID: $(cat "$RUN_DIR/server.pid")"
  [ "$web_running" = true ]    && echo "  web    PID: $(cat "$RUN_DIR/web.pid")"
  if [ "${AGENTARA_UP_IGNORE_RUNNING:-0}" = "1" ]; then
    exit 0
  fi
  echo "Run 'make down' to stop first."
  exit 1
fi

# Clean up any stale PID files from previous runs
rm -f "$RUN_DIR/server.pid" "$RUN_DIR/web.pid"

echo "Starting Agentara in the background..."

# Start backend server under the supervisor (auto-restart + Feishu crash alert).
# The tracked PID is the supervisor's; it forwards SIGTERM to the child so
# `make down` still tears down the whole tree.
cd "$PROJECT_DIR"
nohup bun run start:supervised > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "  Server failed to start. Check .run/logs/server.log for details."
  exit 1
fi
echo "$SERVER_PID" > "$RUN_DIR/server.pid"
echo "  Server started (PID: $SERVER_PID), log: .run/logs/server.log"

# Start web dev server
nohup bun run dev:web > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
sleep 1
if ! kill -0 "$WEB_PID" 2>/dev/null; then
  echo "  Web failed to start. Check .run/logs/web.log for details."
  echo "  Cleaning up server process..."
  bash "$PROJECT_DIR/scripts/down.sh"
  exit 1
fi
echo "$WEB_PID" > "$RUN_DIR/web.pid"
echo "  Web started    (PID: $WEB_PID), log: .run/logs/web.log"

echo ""
echo "Agentara is running in the background."
echo "Use 'make down' to stop."
