from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_railway_start_is_serving_only():
    script = (ROOT / "scripts" / "railway-start.sh").read_text()

    assert "run_sync_once.py" not in script
    assert "refresh_message_links.py" not in script
    assert "enrich_link_authors.py" not in script
    assert "run_wisdom.py" not in script
    assert "run_synthesis.py" not in script


def test_local_sync_script_does_not_trigger_remote_analysis():
    script = (ROOT / "scripts" / "local_sync_to_railway.sh").read_text()

    assert "--skip-remote-refresh" not in script
    assert "RUN_REMOTE_REFRESH" not in script
    assert "railway ssh" not in script
    assert "Local -> Railway sync complete." in script


def test_push_railway_launchd_template_uses_supported_command():
    template = (ROOT / "launchd" / "com.vibez-monitor.push-railway.plist").read_text()

    assert "--skip-remote-refresh" not in template
    assert "./scripts/local_sync_to_railway.sh --push-only" in template
