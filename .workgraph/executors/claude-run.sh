#!/usr/bin/env bash
# ABOUTME: WorkGraph Claude executor wrapper for current Claude CLI prompt contract
# ABOUTME: Converts piped prompt input into a positional prompt argument and forwards extra CLI args

set -euo pipefail

unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

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

PROMPT="$(cat)"
if [[ -z "${PROMPT//[[:space:]]/}" ]]; then
  echo "error: empty workgraph prompt" >&2
  exit 1
fi

exec "$CLAUDE_BIN" \
  --print \
  --dangerously-skip-permissions \
  --no-session-persistence \
  "$@" \
  "$PROMPT"
