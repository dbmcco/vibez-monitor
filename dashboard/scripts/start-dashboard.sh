#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/braydon/projects/personal/vibez-monitor"
DASHBOARD_DIR="$ROOT_DIR/dashboard"
ENV_FILE="$DASHBOARD_DIR/.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export VIBEZ_DB_PATH="${VIBEZ_DB_PATH:-$ROOT_DIR/vibez.db}"
cd "$DASHBOARD_DIR"

if [ -x "/Users/braydon/.nvm/versions/node/v22.22.0/bin/node" ]; then
  NODE_BIN="/Users/braydon/.nvm/versions/node/v22.22.0/bin/node"
elif [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
  NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
else
  NODE_BIN="$(command -v node)"
fi

echo "Starting dashboard with $NODE_BIN ($("$NODE_BIN" -v))" >&2
exec "$NODE_BIN" "$DASHBOARD_DIR/node_modules/next/dist/bin/next" start --port 3100 --hostname 0.0.0.0
