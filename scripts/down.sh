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

# Recursively collect a PID and all of its descendants, leaves first.
# `bun run <script>` is a wrapper that spawns the real worker as a child;
# killing only the tracked wrapper PID orphans that worker (it keeps the
# Feishu connection alive on stale code). Walking the tree fixes that.
collect_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    collect_tree "$child"
  done
  echo "$pid"
}

# TERM a set of PIDs, wait for graceful exit, then KILL stragglers.
kill_pids() {
  local pids="$1"
  [ -z "$pids" ] && return 0

  local pid
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 "$GRACEFUL_WAIT_TICKS"); do
    local alive=false
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then alive=true; fi
    done
    [ "$alive" = false ] && break
    sleep 0.5
  done
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
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

  # Kill the wrapper AND every descendant (the real worker lives below it).
  local tree
  tree="$(collect_tree "$pid")"
  kill_pids "$tree"

  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name: WARNING - failed to stop (PID: $pid)"
    EXIT_CODE=1
  else
    echo "  $name: stopped (PID: $pid)"
  fi

  rm -f "$pid_file"
}

# True when PID's cwd is inside PROJECT_DIR, or its args reference it. Used to
# scope the orphan sweep to THIS project so we never touch unrelated `bun run`
# processes from other repos.
proc_in_project() {
  local pid="$1"
  local cwd args
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2- || true)"
  case "$cwd" in
    "$PROJECT_DIR"|"$PROJECT_DIR"/*) return 0 ;;
  esac
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  case "$args" in
    *"$PROJECT_DIR"*) return 0 ;;
  esac
  return 1
}

# Sweep orphaned processes from earlier runs that aren't tracked by any PID
# file (e.g. wrapper children reparented to init by previous buggy stops).
# Matched by command pattern, then filtered to this project's cwd/args.
sweep_orphans() {
  local self=$$
  local pattern pid candidates=""
  for pattern in \
    "bun run start:server" \
    "bun run index.ts" \
    "bun run dev:web" \
    "bun run dev" \
    "$PROJECT_DIR/web/node_modules/.bin/vite"
  do
    candidates="$candidates $(pgrep -f "$pattern" 2>/dev/null || true)"
  done

  local seen=" " killed=""
  for pid in $candidates; do
    [ "$pid" = "$self" ] && continue
    case "$seen" in *" $pid "*) continue ;; esac
    seen="$seen$pid "
    kill -0 "$pid" 2>/dev/null || continue
    if proc_in_project "$pid"; then
      kill_pids "$(collect_tree "$pid")"
      killed="$killed $pid"
    fi
  done

  if [ -n "$killed" ]; then
    echo "  swept orphaned processes:$killed"
  fi
}

echo "Stopping Agentara..."
stop_process "server"
stop_process "web"
sweep_orphans
echo "Done."
exit "$EXIT_CODE"
