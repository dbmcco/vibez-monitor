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

launchctl load ~/Library/LaunchAgents/com.vibez-monitor.sync.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.synthesis.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.dashboard.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.enrich-link-authors.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.push-railway.plist
```

## Reloading jobs (after a reboot or after editing any plist)

The setup block above is for first-time install. For day-to-day reloads, use the
idempotent helper so jobs are never partially loaded — a partial reload once
silently dropped `synthesis` (which generates the daily briefing) and stalled
the briefing for days:

```bash
./launchd/reload.sh
```

It reloads the installed recurring jobs (`sync`, `synthesis`, `push-railway`)
and skips anything not installed. Run it after every reboot and after any plist
edit. (The `dashboard` job is a `RunAtLoad` local dev server — load it separately
only if you run the dashboard locally.)

---

The `com.vibez-monitor.push-railway.plist` template is intended for lightweight cloud freshness:

- It runs every 15 minutes via `StartInterval=900`
- It calls `./scripts/local_sync_to_railway.sh --push-only`
- It assumes `com.vibez-monitor.sync` is already keeping the local SQLite database current

Local classification and embedding are disabled by default. Railway enrichment owns classifications,
message embeddings, and link embeddings for the production website.
