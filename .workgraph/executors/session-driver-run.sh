#!/usr/bin/env bash
# ABOUTME: WorkGraph executor bridge to claude-session-driver
# ABOUTME: Launches a worker, sends task prompt, waits for completion

set -euo pipefail

TASK_ID="${WG_TASK_ID:?WG_TASK_ID must be set}"
PROJECT_DIR="${WG_PROJECT_DIR:?WG_PROJECT_DIR must be set}"
PROMPT="${WG_PROMPT:?WG_PROMPT must be set}"
TIMEOUT="${WG_TIMEOUT:-1800}"

if [[ -d "$PROJECT_DIR/.workgraph/bin" ]]; then
  export PATH="$PROJECT_DIR/.workgraph/bin:$PATH"
fi

detect_manual_owner_assist() {
  local policy_path="${PROJECT_DIR}/.workgraph/drift-policy.toml"
  if [[ ! -f "$policy_path" ]]; then
    return 1
  fi

  python3 - "$TASK_ID" "$policy_path" <<'PY'
import json
import subprocess
import sys
import tomllib
from pathlib import Path

task_id = sys.argv[1]
policy_path = Path(sys.argv[2])

try:
    data = tomllib.loads(policy_path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(1)

mode = str(((data.get("speedriftd") or {}).get("manual_owner_policy") or "hold")).strip().lower()
if mode != "assist":
    raise SystemExit(1)

try:
    result = subprocess.run(
        ["wg", "--dir", str(policy_path.parent), "show", task_id, "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    task = json.loads(result.stdout)
except Exception:
    raise SystemExit(1)

owner = str(task.get("agent") or "").strip()
if not owner:
    raise SystemExit(1)

owner_tag = f"agent:{owner}"
executors = ((data.get("routing") or {}).get("executors") or {})
for cfg in executors.values():
    pattern = str((cfg or {}).get("tag_match") or "")
    if pattern.endswith(":*") and owner_tag.startswith(pattern[:-1]):
        raise SystemExit(1)
    if pattern == owner_tag:
        raise SystemExit(1)

print(owner)
PY
}

manual_owner_release() {
  if [[ -z "${WG_MANUAL_OWNER_ASSIST:-}" ]]; then
    return
  fi
  local status
  status="$(wg --dir "$PROJECT_DIR/.workgraph" show "$TASK_ID" --json 2>/dev/null | jq -r '.status // "unknown"' || echo "unknown")"
  if [[ "$status" != "in-progress" ]]; then
    return
  fi
  if [[ -n "${MANUAL_OWNER_LOG_MESSAGE:-}" ]]; then
    wg --dir "$PROJECT_DIR/.workgraph" log "$TASK_ID" "$MANUAL_OWNER_LOG_MESSAGE" >/dev/null 2>&1 || true
  fi
  wg --dir "$PROJECT_DIR/.workgraph" unclaim "$TASK_ID" >/dev/null 2>&1 || true
}

MANUAL_OWNER_ID=""
if MANUAL_OWNER_ID="$(detect_manual_owner_assist 2>/dev/null)"; then
  export WG_MANUAL_OWNER_ASSIST=1
  export WG_MANUAL_OWNER_ID="$MANUAL_OWNER_ID"
  MANUAL_OWNER_LOG_MESSAGE="Advisory worker session finished; leaving this task open for ${MANUAL_OWNER_ID} review."
  trap manual_owner_release EXIT
  PROMPT=$'## Manual Owner Assist Mode\n- This task remains owned by '"${MANUAL_OWNER_ID}"$'; you may investigate and make progress, but do not close it.\n- If you need owner input or believe the work is ready for review, record that with `wg log '"${TASK_ID}"$' "..."`.\n- Before you stop, leave the task open with `wg unclaim '"${TASK_ID}"$'` unless the owner explicitly delegated terminal authority.\n- Do not run `wg done` or `wg fail` in this mode.\n\n'"$PROMPT"
fi

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

EVENT_FILE="/tmp/claude-workers/${SESSION_ID}.events.jsonl"
META_FILE="/tmp/claude-workers/${SESSION_ID}.meta"
LOG_FILE=""

if [[ -f "$META_FILE" ]]; then
  CWD=$(jq -r '.cwd // empty' "$META_FILE" 2>/dev/null || true)
  if [[ -n "$CWD" && -d "$CWD" ]]; then
    CWD=$(cd "$CWD" && pwd -P)
    ENCODED_PATH="${CWD//\//-}"
    LOG_FILE="$HOME/.claude/projects/${ENCODED_PATH}/${SESSION_ID}.jsonl"
  fi
fi

count_text_messages() {
  if [[ -z "$LOG_FILE" || ! -f "$LOG_FILE" ]]; then
    echo 0
    return
  fi
  jq -s '[.[] | select(.type == "assistant" and ((.message.content // []) | any(.type == "text")))] | length' "$LOG_FILE" 2>/dev/null || echo 0
}

last_text_response() {
  if [[ -z "$LOG_FILE" || ! -f "$LOG_FILE" ]]; then
    return
  fi
  jq -rs 'map(select(.type == "assistant" and ((.message.content // []) | any(.type == "text")))) | if length == 0 then "" else (last | [(.message.content // [])[] | select(.type == "text") | .text] | join("\n")) end' "$LOG_FILE" 2>/dev/null
}

BEFORE_COUNT=$(count_text_messages)
AFTER_LINE=0
if [[ -f "$EVENT_FILE" ]]; then
  AFTER_LINE=$(wc -l < "$EVENT_FILE" | tr -d ' ')
fi

if ! "$CSD_SCRIPTS/send-prompt.sh" "$WORKER_NAME" "$PROMPT" >/dev/null 2>&1; then
  echo "error: failed to send prompt to worker" >&2
  "$CSD_SCRIPTS/stop-worker.sh" "$WORKER_NAME" "$SESSION_ID" 2>/dev/null || true
  exit 1
fi

if ! "$CSD_SCRIPTS/wait-for-event.sh" "$SESSION_ID" stop "$TIMEOUT" --after-line "$AFTER_LINE" >/dev/null 2>&1; then
  echo "error: worker did not finish within ${TIMEOUT}s" >&2
  "$CSD_SCRIPTS/stop-worker.sh" "$WORKER_NAME" "$SESSION_ID" 2>/dev/null || true
  exit 1
fi

RESPONSE=""
for _ in $(seq 1 50); do
  AFTER_COUNT=$(count_text_messages)
  if [[ "$AFTER_COUNT" =~ ^[0-9]+$ && "$BEFORE_COUNT" =~ ^[0-9]+$ && "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]]; then
    RESPONSE=$(last_text_response)
    if [[ -n "$RESPONSE" && "$RESPONSE" != "null" ]]; then
      break
    fi
  fi
  sleep 0.1
done

if [[ -z "$RESPONSE" || "$RESPONSE" == "null" ]]; then
  echo "error: timed out waiting for assistant response in session log" >&2
  "$CSD_SCRIPTS/stop-worker.sh" "$WORKER_NAME" "$SESSION_ID" 2>/dev/null || true
  exit 1
fi

echo "$RESPONSE"

# Cleanup
"$CSD_SCRIPTS/stop-worker.sh" "$WORKER_NAME" "$SESSION_ID" 2>/dev/null || true
