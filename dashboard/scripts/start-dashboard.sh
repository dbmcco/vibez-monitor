#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DASHBOARD_DIR/.." && pwd)"
ENV_FILE="$DASHBOARD_DIR/.env.local"

if [ -f "$ENV_FILE" ]; then
  while IFS= read -r raw || [ -n "$raw" ]; do
    case "$raw" in
      "" | \#*) continue
    esac

    key="${raw%%=*}"
    value="${raw#*=}"

    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi

    if [ "${#value}" -ge 2 ]; then
      first_char="${value:0:1}"
      last_char="${value: -1}"
      if { [ "$first_char" = '"' ] && [ "$last_char" = '"' ]; } || {
        [ "$first_char" = "'" ] && [ "$last_char" = "'" ];
      }; then
        value="${value:1:${#value}-2}"
      fi
    fi

    export "$key=$value"
  done <"$ENV_FILE"
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

if ! "$NODE_BIN" -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.close();' >/dev/null 2>&1; then
  echo "Detected native module mismatch; rebuilding better-sqlite3 for $("$NODE_BIN" -v)." >&2
  npm rebuild better-sqlite3 >/dev/null
fi

BUILD_ID_FILE="$DASHBOARD_DIR/.next/BUILD_ID"
BUILD_INPUTS=(
  "$DASHBOARD_DIR/src"
  "$DASHBOARD_DIR/public"
  "$DASHBOARD_DIR/package.json"
  "$DASHBOARD_DIR/package-lock.json"
  "$DASHBOARD_DIR/tsconfig.json"
  "$DASHBOARD_DIR/eslint.config.mjs"
)

needs_build=0
if [ ! -f "$BUILD_ID_FILE" ]; then
  needs_build=1
else
  for input in "${BUILD_INPUTS[@]}"; do
    [ -e "$input" ] || continue
    if find "$input" -type f -newer "$BUILD_ID_FILE" -print -quit 2>/dev/null | grep -q .; then
      needs_build=1
      break
    fi
  done
fi

if [ "$needs_build" -eq 1 ]; then
  echo "Detected newer dashboard sources; rebuilding before start." >&2
  "$NODE_BIN" "$DASHBOARD_DIR/node_modules/next/dist/bin/next" build
fi

echo "Starting dashboard with $NODE_BIN ($("$NODE_BIN" -v))" >&2
exec "$NODE_BIN" "$DASHBOARD_DIR/node_modules/next/dist/bin/next" start --port 3100 --hostname 0.0.0.0
