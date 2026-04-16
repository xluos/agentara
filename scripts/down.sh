#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$PROJECT_DIR/.run"

GRACEFUL_WAIT_TICKS=10  # 10 × 0.5s = 5 seconds
EXIT_CODE=0

# Expected command patterns per process name
expected_cmd_for() {
  case "$1" in
    server) echo "bun run start:server" ;;
    web)    echo "bun run dev:web" ;;
    *)      echo "" ;;
  esac
}

# Verify PID belongs to the expected process
is_our_process() {
  local pid="$1"
  local name="$2"
  local expected
  expected="$(expected_cmd_for "$name")"

  if [ -z "$expected" ]; then
    return 0  # no pattern to match, assume ours
  fi

  local cmd
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if echo "$cmd" | grep -qF "$expected"; then
    return 0
  fi
  return 1
}

stop_process() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"

  if [ ! -f "$pid_file" ]; then
    echo "  $name: not running (no PID file)"
    return
  fi

  local pid
  pid="$(cat "$pid_file")"

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "  $name: not running (stale PID: $pid)"
    rm -f "$pid_file"
    return
  fi

  # Guard against PID reuse: verify the process matches what we started
  if ! is_our_process "$pid" "$name"; then
    echo "  $name: PID $pid is no longer an Agentara process, skipping (stale PID file)"
    rm -f "$pid_file"
    return
  fi

  kill "$pid" 2>/dev/null || true
  # Wait for graceful shutdown
  for _ in $(seq 1 "$GRACEFUL_WAIT_TICKS"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  # Force kill if still running
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi
  # Final verification
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name: WARNING - failed to stop (PID: $pid)"
    EXIT_CODE=1
  else
    echo "  $name: stopped (PID: $pid)"
  fi

  rm -f "$pid_file"
}

echo "Stopping Agentara..."
stop_process "server"
stop_process "web"
echo "Done."
exit "$EXIT_CODE"
