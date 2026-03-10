#!/usr/bin/env bash
# ABOUTME: WorkGraph executor bridge to claude-session-driver
# ABOUTME: Launches a worker, sends task prompt, waits for completion

set -euo pipefail

TASK_ID="${WG_TASK_ID:?WG_TASK_ID must be set}"
PROJECT_DIR="${WG_PROJECT_DIR:?WG_PROJECT_DIR must be set}"
PROMPT="${WG_PROMPT:?WG_PROMPT must be set}"
TIMEOUT="${WG_TIMEOUT:-1800}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Discover session-driver scripts
CSD_SCRIPTS="${CLAUDE_SESSION_DRIVER_SCRIPTS:-}"
if [[ -z "$CSD_SCRIPTS" ]]; then
  CSD_SCRIPTS=$(find ~/.claude/plugins/cache -path "*/claude-session-driver/*/scripts" -type d 2>/dev/null | head -1)
fi

if [[ -z "$CSD_SCRIPTS" || ! -d "$CSD_SCRIPTS" ]]; then
  echo "error: claude-session-driver scripts not found" >&2
  exit 1
fi

WORKER_NAME="wg-task-${TASK_ID}"

# Launch worker
RESULT=$("$CSD_SCRIPTS/launch-worker.sh" "$WORKER_NAME" "$PROJECT_DIR" 2>&1)
SESSION_ID=$(echo "$RESULT" | jq -r '.session_id')

if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "error: failed to launch worker" >&2
  echo "$RESULT" >&2
  exit 1
fi

# Converse and collect response
RESPONSE=$("$SCRIPT_DIR/session-driver-converse.sh" "$CSD_SCRIPTS" "$WORKER_NAME" "$SESSION_ID" "$PROMPT" "$TIMEOUT" 2>&1) || true

echo "$RESPONSE"

# Cleanup
"$CSD_SCRIPTS/stop-worker.sh" "$WORKER_NAME" "$SESSION_ID" 2>/dev/null || true
