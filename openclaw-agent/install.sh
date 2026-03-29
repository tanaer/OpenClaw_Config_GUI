#!/usr/bin/env bash
# OpenClaw Remote Agent Installer
# Usage: curl -fsSL https://your-server/install.sh | bash -s -- --token YOUR_TOKEN [--port 18790] [--manager-url http://server:8091]
set -e

AGENT_PORT=18790
TOKEN=""
MANAGER_URL=""
NODE_NAME=""
INSTANCE_NAME=""
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
AGENT_DIR="$OPENCLAW_HOME/agent"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --port)  AGENT_PORT="$2"; shift 2 ;;
    --manager-url) MANAGER_URL="$2"; shift 2 ;;
    --name) NODE_NAME="$2"; shift 2 ;;
    --instance) INSTANCE_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Derive instance name from OPENCLAW_HOME if not specified
if [[ -z "$INSTANCE_NAME" ]]; then
  # Extract instance name from path like ~/.openclaw-finance -> finance
  BASENAME=$(basename "$OPENCLAW_HOME")
  if [[ "$BASENAME" == ".openclaw" ]]; then
    INSTANCE_NAME="default"
  else
    INSTANCE_NAME="${BASENAME#.openclaw}"
    INSTANCE_NAME="${INSTANCE_NAME#-}"
  fi
fi

if [[ "$INSTANCE_NAME" == "default" ]] || [[ -z "$INSTANCE_NAME" ]]; then
  SERVICE_NAME="openclaw-agent"
else
  SERVICE_NAME="openclaw-agent-$INSTANCE_NAME"
fi

AGENT_DIR="$OPENCLAW_HOME/agent"

if [[ -z "$TOKEN" ]]; then
  echo "[ERROR] --token is required"
  echo "Usage: curl -fsSL https://your-server/install.sh | bash -s -- --token YOUR_TOKEN"
  exit 1
fi

if [[ -z "$NODE_NAME" ]]; then
  NODE_NAME="$(hostname 2>/dev/null || echo node-$(date +%s))"
fi

echo "=== OpenClaw Remote Agent Installer ==="
echo "Instance:    $INSTANCE_NAME"
echo "Home:        $OPENCLAW_HOME"
echo "Port:        $AGENT_PORT"
echo "Node Name:   $NODE_NAME"
echo "Service:     $SERVICE_NAME"
echo "Manager URL: ${MANAGER_URL:-not set}"

# Ensure node is available
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is required. Install Node 18+ first."
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [[ "$NODE_VER" -lt 18 ]]; then
  echo "[ERROR] Node.js 18+ required (found v$NODE_VER)"
  exit 1
fi

# Create dirs
mkdir -p "$AGENT_DIR"
mkdir -p "$OPENCLAW_HOME"

# Write token
echo "$TOKEN" > "$OPENCLAW_HOME/agent-token"
chmod 600 "$OPENCLAW_HOME/agent-token"
echo "[OK] Token saved to $OPENCLAW_HOME/agent-token"

# Download agent.js from the same server
SCRIPT_URL="${AGENT_SCRIPT_URL:-}"
if [[ -n "$SCRIPT_URL" ]]; then
  curl -fsSL "$SCRIPT_URL" -o "$AGENT_DIR/agent.js"
  echo "[OK] Downloaded agent.js"
else
  # Embed agent.js inline (populated by server at /install.sh?embed=1)
  if [[ -f "$AGENT_DIR/agent.js" ]]; then
    echo "[OK] agent.js already present"
  else
    echo "[WARN] agent.js not found. Set AGENT_SCRIPT_URL or copy agent.js to $AGENT_DIR/agent.js manually."
  fi
fi

chmod +x "$AGENT_DIR/agent.js" 2>/dev/null || true

# Install as systemd service (Linux)
if command -v systemctl &>/dev/null && [[ "$(uname)" == "Linux" ]]; then
  SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
  mkdir -p "$(dirname "$SERVICE_FILE")"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OpenClaw Remote Agent
After=network.target

[Service]
Type=simple
ExecStart=$(command -v node) $AGENT_DIR/agent.js --port $AGENT_PORT
Restart=on-failure
RestartSec=5
Environment=OPENCLAW_HOME=$OPENCLAW_HOME
Environment=MANAGER_URL=$MANAGER_URL

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME"
  echo "[OK] systemd service installed and started"
  systemctl --user status "$SERVICE_NAME" --no-pager || true

elif [[ "$(uname)" == "Darwin" ]]; then
  # macOS LaunchAgent
  PLIST="$HOME/Library/LaunchAgents/ai.openclaw.agent.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$AGENT_DIR/agent.js</string>
    <string>--port</string><string>$AGENT_PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLAW_HOME</key><string>$OPENCLAW_HOME</string>
    <key>MANAGER_URL</key><string>$MANAGER_URL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$OPENCLAW_HOME/agent.log</string>
  <key>StandardErrorPath</key><string>$OPENCLAW_HOME/agent.err</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "[OK] LaunchAgent installed and started"

else
  # Fallback: run in background
  nohup node "$AGENT_DIR/agent.js" --port "$AGENT_PORT" \
    > "$OPENCLAW_HOME/agent.log" 2>&1 &
  echo "[OK] Agent started in background (PID $!)"
fi

# 自动注册到管理端（如果提供了 manager URL）
if [[ -n "$MANAGER_URL" ]]; then
  echo "[INFO] Registering node to manager: $MANAGER_URL"
  HOST_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -z "$HOST_ADDR" ]]; then
    HOST_ADDR="$(hostname 2>/dev/null || echo localhost)"
  fi

  REGISTER_PAYLOAD=$(cat <<EOF
{"name":"$NODE_NAME","host":"$HOST_ADDR","port":$AGENT_PORT,"token":"$TOKEN","ssl":false}
EOF
)

  REGISTER_RESPONSE=$(curl -fsSL -X POST "$MANAGER_URL/api/nodes/register" \
    -H 'Content-Type: application/json' \
    -d "$REGISTER_PAYLOAD")
  
  if echo "$REGISTER_RESPONSE" | grep -q '"success":true'; then
    NODE_ID=$(echo "$REGISTER_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [[ -n "$NODE_ID" ]]; then
      echo "$NODE_ID" > "$OPENCLAW_HOME/agent-node-id"
      echo "[OK] Node registered with ID: $NODE_ID"
    else
      echo "[OK] Node auto-registered to manager"
    fi
  else
    echo "[WARN] Auto-register failed. You can add node manually in GUI."
  fi
fi

echo ""
echo "=== Installation complete ==="
echo "Agent running on port $AGENT_PORT"
echo "Test: curl -H 'X-Agent-Token: $TOKEN' http://localhost:$AGENT_PORT/health"
