#!/usr/bin/env bash
# vibez-monitor healthcheck: alerts if the sync daemon or the nightly Atlas run
# has gone stale. Runs every 30 min via launchd (com.vibez-monitor.healthcheck).
# Pure bash + macOS built-ins — no external dependencies.
#
# In July 2026 both the sync daemon and the nightly 4:30 run failed silently for
# ~2 days with no alert. This script exists to catch that class of outage fast.
#
# Checks:
#   A)  sync.log freshness     — must have been written within SYNC_STALE_SECONDS.
#   A2) sync not crash-looping — recent tail must be free of 401/traceback lines.
#   B)  nightly ran today      — only enforced after NIGHTLY_BUFFER_HOUR (ET), to
#                               avoid false alerts before the 4:30 job's window.
# On any failure: macOS notification + line in healthcheck.log + exit 1.
set -uo pipefail

SYNC_LOG="/Users/braydon/Library/Logs/vibez-monitor/sync.log"
DAILY_LOG="/Users/braydon/Library/Logs/vibez-monitor/daily-update-stdout.log"
HC_LOG="/Users/braydon/Library/Logs/vibez-monitor/healthcheck.log"
SYNC_STALE_SECONDS=3600   # 60 min — the sync daemon writes every few minutes
NIGHTLY_BUFFER_HOUR=6     # don't expect the 4:30 nightly until after 6 AM ET

mkdir -p "$(dirname "$HC_LOG")"

now_s="$(date +%s)"
stamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"

fail() {
  # Record the failure, notify the desktop user, and exit non-zero so launchd
  # also registers a failure (last exit code) on the healthcheck job itself.
  local msg="$1"
  echo "$stamp healthcheck: FAIL — $msg" >> "$HC_LOG"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$msg\" with title \"vibez-monitor healthcheck\"" >/dev/null 2>&1 || true
  fi
  echo "healthcheck FAIL: $msg" >&2
  exit 1
}

# --- CHECK A: sync daemon freshness --------------------------------------
[[ -f "$SYNC_LOG" ]] || fail "sync.log missing at $SYNC_LOG"
sync_mtime="$(stat -f %m "$SYNC_LOG" 2>/dev/null || echo 0)"
sync_age=$(( now_s - sync_mtime ))
(( sync_age <= SYNC_STALE_SECONDS )) \
  || fail "sync.log stale (last write ${sync_age}s ago; threshold ${SYNC_STALE_SECONDS}s)"
sync_human="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$SYNC_LOG")"

# --- CHECK A2: sync not crash-looping ------------------------------------
# A fresh mtime isn't enough — during the Jul 2026 outage the daemon was
# crash-looping and writing 401/Traceback lines constantly, so the log stayed
# "fresh" while sync was actually dead. Scan the recent tail for the error
# signatures of an actively-failing sync.
sync_tail_errors="$(tail -30 "$SYNC_LOG" 2>/dev/null | grep -ciE 'HTTP Error 401|HTTPError|Unauthorized|token is INACTIVE|Traceback \(most recent')"
if (( sync_tail_errors > 0 )); then
  fail "sync.log shows ${sync_tail_errors} recent error line(s) (401/traceback) — sync likely crash-looping"
fi

# --- CHECK B: nightly ran today (only after the 6 AM ET buffer) -----------
# `date +%H` is zero-padded; force base-10 so hours 08/09 aren't read as octal.
et_hour="$(TZ=America/New_York date +%H)"
et_today="$(TZ=America/New_York date +%Y-%m-%d)"
nightly_status="n/a"
if (( 10#$et_hour >= NIGHTLY_BUFFER_HOUR )); then
  [[ -f "$DAILY_LOG" ]] || fail "daily-update-stdout.log missing at $DAILY_LOG"
  # A "Starting" line whose timestamp contains today's ET date => it ran today.
  if grep "Starting daily Vibez update" "$DAILY_LOG" 2>/dev/null | grep -q "$et_today"; then
    nightly_status="ran"
  else
    fail "daily-update did not run today ($et_today)"
  fi
fi

# --- all checks passed ---------------------------------------------------
echo "$stamp healthcheck: OK — sync=$sync_human; nightly=$nightly_status" >> "$HC_LOG"
echo "healthcheck OK — sync=$sync_human; nightly=$nightly_status"
exit 0
