#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="ai.agentara"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LAUNCHD_DIR="$HOME/.agentara/launchd"
WRAPPER_PATH="$LAUNCHD_DIR/run-agentara.sh"
LOG_DIR="$LAUNCHD_DIR/logs"
DOMAIN="gui/$(id -u)"
LAUNCHD_PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/bin:/sbin:/usr/sbin"

mkdir -p "$PLIST_DIR" "$LAUNCHD_DIR" "$LOG_DIR"
: > "$LOG_DIR/autostart.log"
: > "$LOG_DIR/autostart.err.log"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
fi

cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export PATH="$LAUNCHD_PATH"
export AGENTARA_UP_IGNORE_RUNNING=1

PROJECT_DIR="$PROJECT_DIR"
RUN_DIR="\$PROJECT_DIR/.run"
LOG_DIR="\$PROJECT_DIR/.run/logs"

mkdir -p "\$RUN_DIR" "\$LOG_DIR"

server_running=false
web_running=false

if [ -f "\$RUN_DIR/server.pid" ] && kill -0 "\$(cat "\$RUN_DIR/server.pid")" 2>/dev/null; then
  server_running=true
fi
if [ -f "\$RUN_DIR/web.pid" ] && kill -0 "\$(cat "\$RUN_DIR/web.pid")" 2>/dev/null; then
  web_running=true
fi

if [ "\$server_running" = true ] || [ "\$web_running" = true ]; then
  echo "Agentara is already running:"
  [ "\$server_running" = true ] && echo "  server PID: \$(cat "\$RUN_DIR/server.pid")"
  [ "\$web_running" = true ]    && echo "  web    PID: \$(cat "\$RUN_DIR/web.pid")"
  exit 0
fi

rm -f "\$RUN_DIR/server.pid" "\$RUN_DIR/web.pid"

echo "Starting Agentara in the background..."

cd "\$PROJECT_DIR"
nohup bun run start:supervised > "\$LOG_DIR/server.log" 2>&1 &
SERVER_PID=\$!
sleep 1
if ! kill -0 "\$SERVER_PID" 2>/dev/null; then
  echo "  Server failed to start. Check .run/logs/server.log for details."
  exit 1
fi
echo "\$SERVER_PID" > "\$RUN_DIR/server.pid"
echo "  Server started (PID: \$SERVER_PID), log: .run/logs/server.log"

nohup bun run dev:web > "\$LOG_DIR/web.log" 2>&1 &
WEB_PID=\$!
sleep 1
if ! kill -0 "\$WEB_PID" 2>/dev/null; then
  echo "  Web failed to start. Check .run/logs/web.log for details."
  kill "\$SERVER_PID" 2>/dev/null || true
  exit 1
fi
echo "\$WEB_PID" > "\$RUN_DIR/web.pid"
echo "  Web started    (PID: \$WEB_PID), log: .run/logs/web.log"
EOF
chmod +x "$WRAPPER_PATH"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAPPER_PATH</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTARA_UP_IGNORE_RUNNING</key>
    <string>1</string>
    <key>PATH</key>
    <string>$LAUNCHD_PATH</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/autostart.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/autostart.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST_PATH"
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl enable "$DOMAIN/$LABEL"

echo "Installed Agentara autostart: $PLIST_PATH"
echo "Label: $LABEL"

sleep 2
if grep -q "Operation not permitted" "$LOG_DIR/autostart.err.log"; then
  cat <<EOF
WARNING: launchd registered the job, but macOS denied background access to the project directory.
The repo is under ~/Documents, which is protected by TCC for LaunchAgent processes.
Grant Full Disk Access to the background execution chain, or move the runtime checkout outside ~/Documents.
Log: $LOG_DIR/autostart.err.log
EOF
fi
