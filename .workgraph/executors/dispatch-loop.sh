#!/usr/bin/env bash
# ABOUTME: Hardened dispatch loop for graphwork/workgraph#4 — daemon auto-dispatch silently fails.
# ABOUTME: Polls `wg ready`, spawns agents, emits JSONL events, heartbeat, hung-command watchdog.

set -euo pipefail

MAX_AGENTS="${WG_MAX_AGENTS:-2}"
POLL_INTERVAL="${WG_POLL_INTERVAL:-30}"
EXECUTOR="${WG_EXECUTOR:-claude}"
REPO_NAME="$(basename "$(pwd)")"
NOTIFY_SCRIPT="${WG_NOTIFY_SCRIPT:-/Users/braydon/projects/experiments/driftdriver/scripts/notify-macos.sh}"

EVENTS_FILE=".workgraph/service/runtime/events.jsonl"
HEARTBEAT_FILE=".workgraph/service/runtime/heartbeat"
mkdir -p "$(dirname "$EVENTS_FILE")"
mkdir -p "$(dirname "$HEARTBEAT_FILE")"

log() { echo "[dispatch-loop] $(date +%H:%M:%S) $*"; }

emit_event() {
  local kind="$1"; shift
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local payload=""
  if [ $# -gt 0 ]; then
    payload=",$1"
  fi
  echo "{\"kind\":\"$kind\",\"repo\":\"$REPO_NAME\",\"ts\":\"$ts\"${payload}}" >> "$EVENTS_FILE"
}

heartbeat() {
  date -u +%Y-%m-%dT%H:%M:%SZ > "$HEARTBEAT_FILE"
}

notify() {
  local title="$1" msg="$2"
  [ -x "$NOTIFY_SCRIPT" ] && "$NOTIFY_SCRIPT" "$title" "$msg" &
  wg notify "$title: $msg" 2>/dev/null &
}

alive_count() {
  local count
  count=$(wg agents 2>/dev/null | grep -c 'alive' 2>/dev/null) || count=0
  echo "$count"
}

ready_tasks() {
  local raw
  raw=$(timeout 15 wg ready 2>/dev/null) || {
    local rc=$?
    if [ "$rc" -eq 124 ]; then
      log "WARN: wg ready hung for 15s — killing daemon and retrying"
      emit_event "daemon.killed" "\"reason\":\"wg_ready_hung\""
      wg service stop 2>/dev/null || true
      sleep 2
      raw=$(timeout 15 wg ready 2>/dev/null) || {
        log "ERROR: wg ready hung again after daemon restart"
        echo ""
        return
      }
    else
      echo ""
      return
    fi
  }
  echo "$raw" \
    | grep -E '^\s+\S+' \
    | awk '{print $1}' \
    | head -n "$((MAX_AGENTS - $(alive_count)))"
}

# Crash trap — emits loop.crashed on unexpected exit
trap 'emit_event "loop.crashed" "\"exit_code\":$?"' EXIT

# Kill stale daemon on startup (graphwork/workgraph#4)
wg service stop 2>/dev/null || true
sleep 1

log "Starting dispatch loop (max_agents=$MAX_AGENTS, poll=${POLL_INTERVAL}s, executor=$EXECUTOR)"
log "Workaround for graphwork/workgraph#4"
notify "$REPO_NAME" "Dispatch loop started (max=$MAX_AGENTS)"

emit_event "loop.started"

CYCLE=0
while true; do
  heartbeat
  ALIVE=$(alive_count)

  if [ "$ALIVE" -ge "$MAX_AGENTS" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  SLOTS=$((MAX_AGENTS - ALIVE))
  TASKS=$(ready_tasks)

  if [ -z "$TASKS" ]; then
    emit_event "tasks.exhausted"
    OPEN=$(wg list --status open 2>/dev/null | grep -c '^\s' 2>/dev/null) || OPEN=0
    if [ "$OPEN" -eq 0 ] && [ "$ALIVE" -eq 0 ]; then
      CYCLE=$((CYCLE + 1))
      if [ "$CYCLE" -ge 3 ]; then
        log "All tasks complete. Exiting."
        notify "$REPO_NAME" "All tasks complete — factory idle"
        # Clean exit — clear crash trap, emit exited event
        trap - EXIT
        emit_event "loop.exited"
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
      emit_event "agent.spawned" "\"task\":\"$TASK_ID\""
    else
      log "ERROR: Failed to spawn: $TASK_ID"
      notify "$REPO_NAME" "FAILED to spawn: $TASK_ID"
      emit_event "spawn.failed" "\"task\":\"$TASK_ID\""
    fi

    SLOTS=$((SLOTS - 1))
    [ "$SLOTS" -le 0 ] && break
  done

  sleep "$POLL_INTERVAL"
done
