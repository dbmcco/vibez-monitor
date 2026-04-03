#!/usr/bin/env bash
# ABOUTME: WorkGraph Claude executor wrapper for current Claude CLI prompt contract
# ABOUTME: Converts piped prompt input into a positional prompt argument and forwards extra CLI args

set -euo pipefail

unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

detect_manual_owner_assist() {
  local task_id="${WG_TASK_ID:-}"
  local project_dir="${PWD}"
  local policy_path="${project_dir}/.workgraph/drift-policy.toml"
  if [[ -z "$task_id" || ! -f "$policy_path" ]]; then
    return 1
  fi

  python3 - "$task_id" "$policy_path" <<'PY'
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
        ["wg", "show", task_id, "--json"],
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
  if [[ -z "${WG_MANUAL_OWNER_ASSIST:-}" || -z "${WG_TASK_ID:-}" ]]; then
    return
  fi
  local status
  status="$(wg show "$WG_TASK_ID" --json 2>/dev/null | grep -o '"status": *"[^"]*"' | head -1 | sed 's/.*"status": *"//;s/"//' || echo "unknown")"
  if [[ "$status" != "in-progress" ]]; then
    return
  fi
  if [[ -n "${MANUAL_OWNER_LOG_MESSAGE:-}" ]]; then
    wg log "$WG_TASK_ID" "$MANUAL_OWNER_LOG_MESSAGE" >/dev/null 2>&1 || true
  fi
  wg unclaim "$WG_TASK_ID" >/dev/null 2>&1 || true
}

# Resolve claude binary — the wg daemon may not inherit the user's full PATH.
CLAUDE_BIN="${CLAUDE_BIN:-}"
if [[ -z "$CLAUDE_BIN" ]]; then
  for candidate in "$HOME/.local/bin/claude" /usr/local/bin/claude; do
    if [[ -x "$candidate" ]]; then
      CLAUDE_BIN="$candidate"
      break
    fi
  done
fi
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if [[ -d "$PWD/.workgraph/bin" ]]; then
  export PATH="$PWD/.workgraph/bin:$PATH"
fi

PROMPT="$(cat)"
if [[ -z "${PROMPT//[[:space:]]/}" ]]; then
  echo "error: empty workgraph prompt" >&2
  exit 1
fi

# ── Agency enrichment via pre-dispatch hook (graceful fallback) ──
# The hook calls agency-assign-workgraph and merges the composed identity
# with the speedrift prompt. If the hook is missing or Agency is unreachable,
# the original prompt passes through unchanged.
PRE_DISPATCH_HOOK="$PWD/.workgraph/hooks/pre-dispatch.sh"
if [[ -x "$PRE_DISPATCH_HOOK" ]]; then
  ENRICHED=$(printf '%s' "$PROMPT" | "$PRE_DISPATCH_HOOK" 2>/dev/null) || true
  if [[ -n "$ENRICHED" ]]; then
    PROMPT="$ENRICHED"
  fi
fi

MANUAL_OWNER_ID=""
if MANUAL_OWNER_ID="$(detect_manual_owner_assist 2>/dev/null)"; then
  export WG_MANUAL_OWNER_ASSIST=1
  export WG_MANUAL_OWNER_ID="$MANUAL_OWNER_ID"
  MANUAL_OWNER_LOG_MESSAGE="Advisory worker session finished; leaving this task open for ${MANUAL_OWNER_ID} review."
  trap manual_owner_release EXIT
  PROMPT=$'## Manual Owner Assist Mode\n- This task remains owned by '"${MANUAL_OWNER_ID}"$'; you may investigate and make progress, but do not close it.\n- If you need owner input or believe the work is ready for review, record that with `wg log '"${WG_TASK_ID:-task}"$' "..."`.\n- Before you stop, leave the task open with `wg unclaim '"${WG_TASK_ID:-task}"$'` unless the owner explicitly delegated terminal authority.\n- Do not run `wg done` or `wg fail` in this mode.\n\n'"$PROMPT"
fi

set +e
"$CLAUDE_BIN" \
  --print \
  --dangerously-skip-permissions \
  --no-session-persistence \
  "$@" \
  "$PROMPT"
EXIT_CODE=$?
set -e

exit $EXIT_CODE
