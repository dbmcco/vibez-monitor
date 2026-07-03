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

timestamp() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

echo "[$(timestamp)] Starting daily Vibez update"
echo "Lookback days: $VIBEZ_PUSH_LOOKBACK_DAYS"

run_with_retry() {
  local label="$1"
  shift
  local attempts="${VIBEZ_DAILY_STEP_RETRIES:-3}"
  local delay="${VIBEZ_DAILY_STEP_RETRY_DELAY_SECONDS:-60}"
  local attempt=1
  while true; do
    echo "[$(timestamp)] ${label}: attempt ${attempt}/${attempts}"
    if "$@"; then
      echo "[$(timestamp)] ${label}: succeeded"
      return 0
    fi
    if [[ "$attempt" -ge "$attempts" ]]; then
      echo "[$(timestamp)] ${label}: failed after ${attempts} attempts" >&2
      return 1
    fi
    echo "[$(timestamp)] ${label}: retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

if ! run_with_retry "Local sync and Railway push" \
  "$ROOT_DIR/scripts/local_sync_to_railway.sh" --lookback-days "$VIBEZ_PUSH_LOOKBACK_DAYS"; then
  if [[ "${VIBEZ_DAILY_ALLOW_STALE_LOCAL_PUSH:-1}" != "1" ]]; then
    exit 1
  fi

  echo "[$(timestamp)] Full local sync failed; pushing existing local data so Atlas can still publish today." >&2
  run_with_retry "Railway push from existing local data" \
    "$ROOT_DIR/scripts/local_sync_to_railway.sh" --push-only --lookback-days "$VIBEZ_PUSH_LOOKBACK_DAYS"
fi

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
    run_with_retry "Railway enrichment and Atlas publish" \
      env VIBEZ_LOCAL_APP_URL="$remote_url" \
        VIBEZ_ATLAS_HOURS="${VIBEZ_DAILY_ATLAS_HOURS:-48}" \
        bash -lc "cd '$ROOT_DIR/dashboard' && node scripts/run-railway-enrichment.mjs"
    echo "Validating Railway Atlas edition with images at ${remote_url}"
    (
      cd "$ROOT_DIR/dashboard"
      VIBEZ_LOCAL_APP_URL="$remote_url" \
      VIBEZ_ATLAS_HOURS="${VIBEZ_DAILY_ATLAS_HOURS:-48}" \
      VIBEZ_ATLAS_RUN_UX_CHECK="${VIBEZ_DAILY_ATLAS_RUN_UX_CHECK:-1}" \
        node scripts/check-atlas-production.mjs
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
    echo "Validating Railway Atlas edition with images at ${remote_url}"
    (
      cd "$ROOT_DIR/dashboard"
      VIBEZ_LOCAL_APP_URL="$remote_url" \
      VIBEZ_ATLAS_HOURS="${VIBEZ_DAILY_ATLAS_HOURS:-48}" \
      VIBEZ_ATLAS_RUN_UX_CHECK="${VIBEZ_DAILY_ATLAS_RUN_UX_CHECK:-1}" \
        node scripts/check-atlas-production.mjs
    )
  fi
fi

echo "[$(timestamp)] Daily Vibez update complete"
