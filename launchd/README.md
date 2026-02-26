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

launchctl load ~/Library/LaunchAgents/com.vibez-monitor.sync.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.synthesis.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.dashboard.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.classify-missing.plist
```
