# launchd Templates

These plist files are templates for macOS `launchd`.

Before loading them, replace placeholders:

- `__VIBEZ_ROOT__` -> absolute path to your repo checkout
- `__LOG_DIR__` -> absolute path to your log directory (for example `~/Library/Logs/vibez-monitor`)

Example setup:

```bash
cd /path/to/vibez-monitor
mkdir -p ~/Library/Logs/vibez-monitor

for f in launchd/*.plist; do
  # When the nightly runs from a worktree but credentials live in the main
  # checkout (or a specific venv python is required), export these before
  # rendering — they are substituted into the daily-update template:
  #   export VIBEZ_ENV_FILE=/Users/you/projects/vibez-monitor/.env
  #   export PYTHON_BIN=/Users/you/projects/vibez-monitor/backend/.venv/bin/python
  sed \
    -e "s|__VIBEZ_ROOT__|$(pwd)|g" \
    -e "s|__LOG_DIR__|$HOME/Library/Logs/vibez-monitor|g" \
    -e "s|__VIBEZ_ENV_FILE__|${VIBEZ_ENV_FILE:-}|g" \
    -e "s|__PYTHON_BIN__|${PYTHON_BIN:-}|g" \
    "$f" > "$HOME/Library/LaunchAgents/$(basename "$f")"
done

# Use the modern bootout/bootstrap API. The legacy unload/load pair can leave
# StartCalendarInterval timers registered-but-unarmed (runs stays 0), which
# silently skipped the 4:30 daily-update run in July 2026.
DOMAIN="gui/$(id -u)"
for plist in ~/Library/LaunchAgents/com.vibez-monitor.{sync,synthesis,dashboard,classify-missing,enrich-link-authors,push-railway,daily-update}.plist; do
  [[ -f "$plist" ]] || continue
  launchctl bootout "$DOMAIN/$(basename "${plist%.plist}")" 2>/dev/null || true
done
for plist in ~/Library/LaunchAgents/com.vibez-monitor.{sync,synthesis,dashboard,enrich-link-authors,push-railway,daily-update}.plist; do
  [[ -f "$plist" ]] || continue
  launchctl bootstrap "$DOMAIN" "$plist"
done
```

The `com.vibez-monitor.daily-update.plist` template is the canonical daily public-site refresh:

- It runs every day at 4:30 AM in `America/New_York`
- It calls `./scripts/daily_update_to_railway.sh`
- The script uses a lock directory so overlapping runs do not duplicate ingest/push work
- It runs one local sync pass, pushes the configured lookback window to Railway, then asks Railway to run enrichment, embeddings, Atlas article generation, channel reports, article image jobs, and publish when `VIBEZ_DAILY_REFRESH_ATLAS` is not `0`
- The Railway enrichment command prints the publish job id, edition date/window, publication timestamp, and per-stage summary; treat that as the nightly health record, not Railway crash-notification email volume
- Set `VIBEZ_ENV_FILE` in the LaunchAgent environment when credentials live outside the checkout being scheduled

The `com.vibez-monitor.push-railway.plist` template is intended for lightweight cloud freshness:

- It runs every 15 minutes via `StartInterval=900`
- It calls `./scripts/local_sync_to_railway.sh --push-only`
- It assumes `com.vibez-monitor.sync` is already keeping the local Postgres database current

Local classification and embedding are disabled by default. Railway enrichment owns classifications,
message embeddings, and link embeddings for the production website.
