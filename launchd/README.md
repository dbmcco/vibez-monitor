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
  sed \
    -e "s|__VIBEZ_ROOT__|$(pwd)|g" \
    -e "s|__LOG_DIR__|$HOME/Library/Logs/vibez-monitor|g" \
    "$f" > "$HOME/Library/LaunchAgents/$(basename "$f")"
done

launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.sync.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.synthesis.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.dashboard.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.classify-missing.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.enrich-link-authors.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.push-railway.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.vibez-monitor.daily-update.plist 2>/dev/null || true

launchctl load ~/Library/LaunchAgents/com.vibez-monitor.sync.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.synthesis.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.dashboard.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.enrich-link-authors.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.push-railway.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.daily-update.plist
```

The `com.vibez-monitor.daily-update.plist` template is the canonical daily public-site refresh:

- It runs every day at 4:30 AM in `America/New_York`
- It calls `./scripts/daily_update_to_railway.sh`
- The script uses a lock directory so overlapping runs do not duplicate ingest/push work
- It runs one local sync pass, pushes the configured lookback window to Railway, then asks Railway to run enrichment, Atlas article generation, channel reports, article image jobs, and publish when `VIBEZ_DAILY_REFRESH_ATLAS` is not `0`
- Daily message/link embedding is disabled unless `VIBEZ_DAILY_MESSAGE_EMBEDDING_LIMIT` or `VIBEZ_DAILY_LINK_EMBEDDING_LIMIT` is explicitly set above `0`
- The Railway enrichment command prints the publish job id, edition date/window, publication timestamp, and per-stage summary; treat that as the nightly health record, not Railway crash-notification email volume
- Set `VIBEZ_ENV_FILE` in the LaunchAgent environment when credentials live outside the checkout being scheduled

The `com.vibez-monitor.push-railway.plist` template is intended for lightweight cloud freshness:

- It runs every 15 minutes via `StartInterval=900`
- It calls `./scripts/local_sync_to_railway.sh --push-only`
- It assumes `com.vibez-monitor.sync` is already keeping the local Postgres database current

Local classification and embedding are disabled by default. Railway enrichment owns classifications.
Remote message/link embeddings are opt-in per daily run so embedding spend cannot resume silently.
