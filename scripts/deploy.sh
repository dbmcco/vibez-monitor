#!/usr/bin/env bash
# ABOUTME: One-command Railway deployment script for vibez-monitor
# ABOUTME: Supports Railway CLI deploy with git fallback and health verification

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT_NAME:-production}"
SERVICE_NAMES_RAW="${RAILWAY_SERVICE_NAMES:-dashboard}"
APP_URL="${VIBEZ_APP_URL:-}"
HEALTH_PATH="${VIBEZ_HEALTH_PATH:-/api/health}"
DEPLOY_METHOD="${VIBEZ_DEPLOY_METHOD:-auto}" # auto | railway | git
SNAPSHOT_SOURCE="${VIBEZ_SNAPSHOT_SOURCE:-auto}" # auto | head | worktree
CHECK_ONLY=0
DETACH=1

load_token_from_env_file() {
  local key="$1"
  awk -F= -v key="$key" '$1==key {sub(/^[^=]*=/, "", $0); gsub(/^"|"$/, "", $0); print $0; exit}' "$ROOT_DIR/.env" 2>/dev/null
}

normalize_auth_env() {
  if [[ -z "${RAILWAY_API_TOKEN:-}" && -n "${RAILWAY_TOKEN:-}" ]]; then
    export RAILWAY_API_TOKEN="$RAILWAY_TOKEN"
  fi

  if [[ -z "${RAILWAY_API_TOKEN:-}" && -z "${RAILWAY_TOKEN:-}" && -f "$ROOT_DIR/.env" ]]; then
    local env_token
    env_token="$(load_token_from_env_file RAILWAY_API_TOKEN)"
    if [[ -z "$env_token" ]]; then
      env_token="$(load_token_from_env_file RAILWAY_TOKEN)"
    fi
    if [[ -n "$env_token" ]]; then
      export RAILWAY_API_TOKEN="$env_token"
    fi
  fi
}

select_snapshot_source() {
  local requested="$1"
  local dirty="$2"
  case "$requested" in
    auto)
      if [[ "$dirty" == "1" ]]; then
        printf 'worktree\n'
      else
        printf 'head\n'
      fi
      ;;
    head|worktree)
      printf '%s\n' "$requested"
      ;;
    *)
      return 1
      ;;
  esac
}

is_git_worktree_dirty() {
  if ! git -C "$ROOT_DIR" diff --quiet --ignore-submodules --; then
    return 0
  fi
  if [[ -n "$(git -C "$ROOT_DIR" ls-files --others --exclude-standard)" ]]; then
    return 0
  fi
  return 1
}

build_head_snapshot() {
  local snapshot_dir="$1"
  git -C "$ROOT_DIR" archive --format=tar HEAD | tar -xf - -C "$snapshot_dir"
}

build_worktree_snapshot() {
  local snapshot_dir="$1"
  local rel_path
  while IFS= read -r rel_path; do
    mkdir -p "$snapshot_dir/$(dirname "$rel_path")"
    cp -a "$ROOT_DIR/$rel_path" "$snapshot_dir/$rel_path"
  done < <(git -C "$ROOT_DIR" ls-files -co --exclude-standard)
}

check_railway_auth() {
  local token="${RAILWAY_API_TOKEN:-${RAILWAY_TOKEN:-}}"
  if [[ -n "$token" ]]; then
    if env -u RAILWAY_TOKEN RAILWAY_API_TOKEN="$token" railway whoami >/dev/null 2>&1; then
      echo "Railway token auth is valid."
      return 0
    fi
    echo "Railway token auth failed; trying local Railway CLI session..."
  fi

  if env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN railway whoami >/dev/null 2>&1; then
    echo "Railway CLI session auth is valid."
    return 0
  fi

  echo "Railway auth unavailable. Set RAILWAY_API_TOKEN or run railway login." >&2
  return 1
}

verify_deploy_url() {
  local base_url="$1"
  local health_url="${base_url%/}${HEALTH_PATH}"

  echo "Waiting for health: $health_url"
  for i in $(seq 1 36); do
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" "$health_url" 2>/dev/null || echo "000")"
    if [[ "$code" == "200" ]]; then
      echo "Deploy live (health=200): ${base_url%/}"
      return 0
    fi
    echo "  attempt $i/36 -> health $code"
    sleep 5
  done

  return 1
}

deploy_via_git() {
  local current_branch
  current_branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
  echo "Deploying via git push from branch '$current_branch'..."
  git -C "$ROOT_DIR" push origin "$current_branch:main"
}

deploy_service_via_railway() {
  local service="$1"
  local snapshot_dir="$2"
  local token="${RAILWAY_API_TOKEN:-${RAILWAY_TOKEN:-}}"
  local status=1

  local -a up_args
  up_args=(up --service "$service" --environment "$ENVIRONMENT_NAME")
  if [[ -n "$PROJECT_ID" ]]; then
    up_args+=(--project "$PROJECT_ID")
  fi
  if [[ "$DETACH" -eq 1 ]]; then
    up_args+=(--detach)
  fi
  if [[ -n "$snapshot_dir" ]]; then
    up_args+=(--path-as-root "$snapshot_dir")
  fi

  echo "Deploying service '$service' via railway up..."
  if [[ -n "$token" ]]; then
    set +e
    env -u RAILWAY_TOKEN RAILWAY_API_TOKEN="$token" railway "${up_args[@]}"
    status=$?
    set -e
    if [[ "$status" -ne 0 ]]; then
      echo "Token-auth deploy failed for '$service'; retrying with local Railway CLI session..."
    fi
  fi

  if [[ "$status" -ne 0 ]]; then
    set +e
    env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN railway "${up_args[@]}"
    status=$?
    set -e
  fi

  return "$status"
}

split_services() {
  local raw="$1"
  IFS=',' read -r -a SERVICE_NAMES <<<"$raw"
}

usage() {
  cat <<'USAGE'
vibez-monitor Railway deploy

Usage:
  ./scripts/deploy.sh [options]

Options:
  --method <auto|railway|git>       Deploy strategy (default: auto)
  --snapshot-source <auto|head|worktree>
                                     Source for Railway deploy snapshot (default: auto)
  --project-id <id>                 Railway project id (optional if repo is linked)
  --environment <name>              Railway environment (default: production)
  --services <csv>                  Service names (default: dashboard)
  --app-url <url>                   URL for post-deploy health check (optional)
  --health-path <path>              Health endpoint path (default: /api/health)
  --check-only                      Validate deploy auth/paths and exit
  --attach                          Follow deploy logs instead of detached mode
  -h, --help                        Show this help
USAGE
}

main() {
  normalize_auth_env

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --method)
        DEPLOY_METHOD="$2"
        shift 2
        ;;
      --snapshot-source)
        SNAPSHOT_SOURCE="$2"
        shift 2
        ;;
      --project-id)
        PROJECT_ID="$2"
        shift 2
        ;;
      --environment)
        ENVIRONMENT_NAME="$2"
        shift 2
        ;;
      --services)
        SERVICE_NAMES_RAW="$2"
        shift 2
        ;;
      --app-url)
        APP_URL="$2"
        shift 2
        ;;
      --health-path)
        HEALTH_PATH="$2"
        shift 2
        ;;
      --check-only)
        CHECK_ONLY=1
        shift
        ;;
      --attach)
        DETACH=0
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  split_services "$SERVICE_NAMES_RAW"

  echo "━━━ vibez-monitor Railway Deploy ━━━"
  echo "Project:         ${PROJECT_ID:-<linked project>}"
  echo "Environment:     $ENVIRONMENT_NAME"
  echo "Services:        ${SERVICE_NAMES[*]}"
  echo "Method:          $DEPLOY_METHOD"
  echo "Snapshot Source: $SNAPSHOT_SOURCE"
  echo "App URL:         ${APP_URL:-<skip health verification>}"
  echo "Health Path:     $HEALTH_PATH"

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    if [[ "$DEPLOY_METHOD" == "git" ]]; then
      git -C "$ROOT_DIR" remote -v >/dev/null
      echo "Check-only: git deploy path is available."
      exit 0
    fi
    if ! command -v railway >/dev/null 2>&1; then
      echo "railway CLI not found. Install with: npm i -g @railway/cli" >&2
      exit 1
    fi
    check_railway_auth
    exit 0
  fi

  cd "$ROOT_DIR"

  local snapshot_dir=""
  if [[ "$DEPLOY_METHOD" == "railway" || "$DEPLOY_METHOD" == "auto" ]]; then
    if ! command -v railway >/dev/null 2>&1; then
      if [[ "$DEPLOY_METHOD" == "railway" ]]; then
        echo "railway CLI not found. Install with: npm i -g @railway/cli" >&2
        exit 1
      fi
    else
      local dirty=0 resolved_source
      if is_git_worktree_dirty; then
        dirty=1
      fi
      resolved_source="$(select_snapshot_source "$SNAPSHOT_SOURCE" "$dirty")" || {
        echo "Invalid --snapshot-source: $SNAPSHOT_SOURCE (expected auto|head|worktree)" >&2
        exit 1
      }
      snapshot_dir="$(mktemp -d "${TMPDIR:-/tmp}/vibez-deploy-XXXXXX")"
      if [[ "$resolved_source" == "worktree" ]]; then
        build_worktree_snapshot "$snapshot_dir"
      else
        build_head_snapshot "$snapshot_dir"
      fi
      echo "Using ${resolved_source} snapshot for Railway deploy."
    fi
  fi

  local railway_ok=1
  if [[ "$DEPLOY_METHOD" == "railway" || "$DEPLOY_METHOD" == "auto" ]]; then
    if [[ -z "$snapshot_dir" ]]; then
      railway_ok=1
    else
      railway_ok=0
      for service in "${SERVICE_NAMES[@]}"; do
        if ! deploy_service_via_railway "$service" "$snapshot_dir"; then
          railway_ok=1
          break
        fi
      done
    fi
  fi

  if [[ -n "$snapshot_dir" ]]; then
    rm -rf "$snapshot_dir"
  fi

  case "$DEPLOY_METHOD" in
    git)
      deploy_via_git
      ;;
    railway)
      if [[ "$railway_ok" -ne 0 ]]; then
        echo "Railway deploy failed." >&2
        exit 1
      fi
      ;;
    auto)
      if [[ "$railway_ok" -ne 0 ]]; then
        echo "Railway deploy failed; falling back to git push deployment..."
        deploy_via_git
      fi
      ;;
    *)
      echo "Invalid --method value: $DEPLOY_METHOD (expected auto|railway|git)" >&2
      exit 1
      ;;
  esac

  if [[ -n "$APP_URL" ]]; then
    if ! verify_deploy_url "$APP_URL"; then
      echo "Deploy triggered but health checks did not pass in time." >&2
      exit 1
    fi
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

