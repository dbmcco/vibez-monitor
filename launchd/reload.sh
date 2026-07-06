#!/usr/bin/env bash
# Idempotently reload the installed vibez-monitor launchd jobs.
#
# WHY THIS EXISTS:
# The daily briefing stalled in July 2026 because a plist reload only loaded
# 2 of the jobs (sync + push-railway) and silently dropped `synthesis`, which
# generates the briefing. Running this single script after a reboot or after
# editing any vibez plist guarantees the full recurring set is loaded, so no
# job gets dropped by a partial manual reload.
#
# Run any time: after reboot, after editing a plist, or to verify health.
#   ./launchd/reload.sh
#
# Scope = the recurring scheduled jobs installed in ~/Library/LaunchAgents.
# Intentionally NOT auto-loaded here:
#   - com.vibez-monitor.dashboard        RunAtLoad LOCAL dev server; load only if you run the dashboard locally.
#   - com.vibez-monitor.enrich-link-authors  template exists but is not installed on this machine.
#   - com.vibez-monitor.classify-missing     intentionally disabled (omitted from the canonical load set).
#   - com.vibez-monitor.wisdom              not in the canonical recurring load set.
#   com.vibez-monitor.daily-update           IS canonical — it drives the nightly Atlas
#                                           publish (runs in the vibez-atlas-redesign worktree).
set -uo pipefail

LA="$HOME/Library/LaunchAgents"
JOBS=(
  com.vibez-monitor.sync
  com.vibez-monitor.synthesis
  com.vibez-monitor.push-railway
  com.vibez-monitor.daily-update
)

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
echo "Reloading vibez-monitor launchd jobs (bootout/bootstrap into $DOMAIN)..."
fail=0
for j in "${JOBS[@]}"; do
  plist="$LA/$j.plist"
  if [[ ! -f "$plist" ]]; then
    echo "  SKIP  $j (no plist installed at $plist)"
    continue
  fi
  # Use the modern bootout/bootstrap API. The legacy unload/load pair can leave
  # StartCalendarInterval timers registered-but-unarmed (launchctl print shows
  # runs = 0 forever), which silently killed the 4:30 daily-update run in Jul 2026.
  launchctl bootout "$DOMAIN/$j" 2>/dev/null || true
  if launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null; then
    echo "  OK    $j"
  else
    echo "  FAIL  $j (launchctl bootstrap returned non-zero)"
    fail=1
  fi
done

echo
echo "Loaded vibez-monitor jobs now:"
launchctl list | awk '$3 ~ /^com\.vibez-monitor/ {print "  " $3 " (last exit " $2 ")"}' || true

exit $fail
