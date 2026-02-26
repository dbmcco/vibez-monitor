#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DASHBOARD_DIR/.." && pwd)"
ENV_FILE="$DASHBOARD_DIR/.env.local"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export VIBEZ_DB_PATH="${VIBEZ_DB_PATH:-$ROOT_DIR/vibez.db}"
cd "$DASHBOARD_DIR"

# Prefer PATH node, then common Homebrew fallback.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
  NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node.js and retry." >&2
  exit 1
fi

echo "Starting dashboard with $NODE_BIN ($("$NODE_BIN" -v))" >&2
exec "$NODE_BIN" "$DASHBOARD_DIR/node_modules/next/dist/bin/next" start --port 3100 --hostname 0.0.0.0
