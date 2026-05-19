#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="${VIBEZ_DAILY_UPDATE_LOCK_DIR:-/tmp/vibez-daily-update.lock}"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Daily update already running; exiting without starting a second ingest." >&2
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cd "$ROOT_DIR"

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    case "$raw" in
      "" | \#*) continue
    esac
    local key="${raw%%=*}"
    local value="${raw#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ "${#value}" -ge 2 ]]; then
      local first_char="${value:0:1}"
      local last_char="${value: -1}"
      if { [[ "$first_char" == '"' && "$last_char" == '"' ]]; } || {
        [[ "$first_char" == "'" && "$last_char" == "'" ]];
      }; then
        value="${value:1:${#value}-2}"
      fi
    fi
    export "$key=$value"
  done <"$env_file"
}

load_env_file "${VIBEZ_ENV_FILE:-}"
load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/dashboard/.env.local"

export TZ="${TZ:-America/New_York}"
export VIBEZ_PUSH_LOOKBACK_DAYS="${VIBEZ_DAILY_PUSH_LOOKBACK_DAYS:-${VIBEZ_PUSH_LOOKBACK_DAYS:-3}}"

echo "[$(date -Is)] Starting daily Vibez update"
echo "Lookback days: $VIBEZ_PUSH_LOOKBACK_DAYS"

"$ROOT_DIR/scripts/local_sync_to_railway.sh" --lookback-days "$VIBEZ_PUSH_LOOKBACK_DAYS"

if [[ "${VIBEZ_DAILY_RAILWAY_ENRICH:-1}" != "0" ]]; then
  remote_url="${VIBEZ_REMOTE_URL:-}"
  if [[ -z "$remote_url" && -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]]; then
    remote_url="https://${RAILWAY_PUBLIC_DOMAIN}"
  fi

  if [[ -z "$remote_url" ]]; then
    echo "Skipping Railway enrichment: VIBEZ_REMOTE_URL is not set." >&2
  elif [[ -z "${VIBEZ_PUSH_API_KEY:-}" ]]; then
    echo "Skipping Railway enrichment: VIBEZ_PUSH_API_KEY is not set." >&2
  else
    echo "Running Railway enrichment at ${remote_url}"
    (
      cd "$ROOT_DIR/dashboard"
      VIBEZ_LOCAL_APP_URL="$remote_url" \
      VIBEZ_ATLAS_HOURS="${VIBEZ_DAILY_ATLAS_HOURS:-48}" \
        node scripts/run-railway-enrichment.mjs
    )
  fi
elif [[ "${VIBEZ_DAILY_REFRESH_ATLAS:-1}" != "0" ]]; then
  remote_url="${VIBEZ_REMOTE_URL:-}"
  if [[ -z "$remote_url" && -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]]; then
    remote_url="https://${RAILWAY_PUBLIC_DOMAIN}"
  fi

  if [[ -z "$remote_url" ]]; then
    echo "Skipping Atlas artifact refresh: VIBEZ_REMOTE_URL is not set." >&2
  elif [[ -z "${VIBEZ_ACCESS_CODE:-}" ]]; then
    echo "Skipping Atlas artifact refresh: VIBEZ_ACCESS_CODE is not set." >&2
  else
    echo "Refreshing Railway Atlas artifact at ${remote_url}"
    (
      cd "$ROOT_DIR/dashboard"
      VIBEZ_LOCAL_APP_URL="$remote_url" \
      VIBEZ_ATLAS_HOURS="${VIBEZ_DAILY_ATLAS_HOURS:-48}" \
        node scripts/generate-atlas-artifact.mjs
    )
  fi
fi

echo "[$(date -Is)] Daily Vibez update complete"
