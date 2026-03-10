#!/usr/bin/env bash

set -euo pipefail

CSD_SCRIPTS="${1:?Usage: session-driver-converse.sh <scripts-dir> <tmux-name> <session-id> <prompt-text> [timeout=120]}"
TMUX_NAME="${2:?Usage: session-driver-converse.sh <scripts-dir> <tmux-name> <session-id> <prompt-text> [timeout=120]}"
SESSION_ID="${3:?Usage: session-driver-converse.sh <scripts-dir> <tmux-name> <session-id> <prompt-text> [timeout=120]}"
PROMPT_TEXT="${4:?Usage: session-driver-converse.sh <scripts-dir> <tmux-name> <session-id> <prompt-text> [timeout=120]}"
TIMEOUT="${5:-120}"

EVENT_FILE="/tmp/claude-workers/${SESSION_ID}.events.jsonl"
META_FILE="/tmp/claude-workers/${SESSION_ID}.meta"

if [[ ! -f "$META_FILE" ]]; then
  echo "Error: Worker metadata file not found: $META_FILE" >&2
  exit 1
fi

CWD=$(jq -r '.cwd' "$META_FILE" 2>/dev/null || true)
if [[ -z "$CWD" || "$CWD" == "null" || ! -d "$CWD" ]]; then
  echo "Error: Could not determine working directory from meta file" >&2
  exit 1
fi

CWD="$(cd "$CWD" && pwd -P)"
ENCODED_PATH=$(echo "$CWD" | sed 's|/|-|g')
LOG_FILE="$HOME/.claude/projects/${ENCODED_PATH}/${SESSION_ID}.jsonl"

count_text_messages() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo 0
    return
  fi

  local count
  count=$(
    jq -rs '
      map(
        select(
          .type == "assistant"
          and ((.message.content // []) | any(.type == "text"))
        )
      )
      | length
    ' "$LOG_FILE" 2>/dev/null || true
  )

  if [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "$count"
  else
    echo 0
  fi
}

last_text_response() {
  if [[ ! -f "$LOG_FILE" ]]; then
    return 1
  fi

  jq -rs '
    map(
      select(
        .type == "assistant"
        and ((.message.content // []) | any(.type == "text"))
      )
    )
    | last
    | [(.message.content // [])[] | select(.type == "text") | .text]
    | join("\n")
  ' "$LOG_FILE" 2>/dev/null
}

BEFORE_COUNT=$(count_text_messages)

AFTER_LINE=0
if [[ -f "$EVENT_FILE" ]]; then
  AFTER_LINE=$(wc -l < "$EVENT_FILE" | tr -d ' ')
fi

bash "$CSD_SCRIPTS/send-prompt.sh" "$TMUX_NAME" "$PROMPT_TEXT"

if ! bash "$CSD_SCRIPTS/wait-for-event.sh" "$SESSION_ID" stop "$TIMEOUT" --after-line "$AFTER_LINE" > /dev/null; then
  echo "Error: Worker did not finish within ${TIMEOUT}s" >&2
  exit 1
fi

for _ in $(seq 1 40); do
  AFTER_COUNT=$(count_text_messages)
  if [[ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]]; then
    RESPONSE=$(last_text_response)
    if [[ -n "$RESPONSE" && "$RESPONSE" != "null" ]]; then
      echo "$RESPONSE"
      exit 0
    fi
  fi
  sleep 0.25
done

echo "Error: Timed out waiting for assistant response in session log" >&2
exit 1
