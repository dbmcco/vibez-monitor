#!/usr/bin/env bash
# ABOUTME: Workaround for graphwork/workgraph#4 — daemon auto-dispatch silently fails.
# ABOUTME: Polls `wg ready`, spawns agents via `wg spawn`, respects max_agents concurrency.

set -euo pipefail

MAX_AGENTS="${WG_MAX_AGENTS:-2}"
POLL_INTERVAL="${WG_POLL_INTERVAL:-30}"
EXECUTOR="${WG_EXECUTOR:-claude}"
REPO_NAME="$(basename "$(pwd)")"
NOTIFY_SCRIPT="${WG_NOTIFY_SCRIPT:-/Users/braydon/projects/experiments/driftdriver/scripts/notify-macos.sh}"

log() { echo "[dispatch-loop] $(date +%H:%M:%S) $*"; }

notify() {
  local title="$1" msg="$2"
  [ -x "$NOTIFY_SCRIPT" ] && "$NOTIFY_SCRIPT" "$title" "$msg" &
  wg notify "$title: $msg" 2>/dev/null &
}

alive_count() {
  wg agents 2>/dev/null \
    | grep -c 'alive' \
    || echo 0
}

ready_tasks() {
  wg ready 2>/dev/null \
    | grep -E '^\s+\S+' \
    | awk '{print $1}' \
    | head -n "$((MAX_AGENTS - $(alive_count)))"
}

log "Starting dispatch loop (max_agents=$MAX_AGENTS, poll=${POLL_INTERVAL}s, executor=$EXECUTOR)"
log "Workaround for graphwork/workgraph#4"
notify "$REPO_NAME" "Dispatch loop started (max=$MAX_AGENTS)"

CYCLE=0
while true; do
  ALIVE=$(alive_count)

  if [ "$ALIVE" -ge "$MAX_AGENTS" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  SLOTS=$((MAX_AGENTS - ALIVE))
  TASKS=$(ready_tasks)

  if [ -z "$TASKS" ]; then
    OPEN=$(wg list --status open 2>/dev/null | grep -c '^\s' || echo 0)
    if [ "$OPEN" -eq 0 ] && [ "$ALIVE" -eq 0 ]; then
      CYCLE=$((CYCLE + 1))
      if [ "$CYCLE" -ge 3 ]; then
        log "All tasks complete. Exiting."
        notify "$REPO_NAME" "All tasks complete — factory idle"
        exit 0
      fi
    fi
    sleep "$POLL_INTERVAL"
    continue
  fi

  CYCLE=0
  for TASK_ID in $TASKS; do
    log "Spawning agent for: $TASK_ID"
    if wg spawn --executor "$EXECUTOR" "$TASK_ID" 2>&1; then
      log "Spawned successfully: $TASK_ID"
    else
      log "ERROR: Failed to spawn: $TASK_ID"
      notify "$REPO_NAME" "FAILED to spawn: $TASK_ID"
    fi

    SLOTS=$((SLOTS - 1))
    [ "$SLOTS" -le 0 ] && break
  done

  sleep "$POLL_INTERVAL"
done
