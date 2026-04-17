from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ROUTED_BACKEND_MODULES = [
    "backend/vibez/classifier.py",
    "backend/vibez/synthesis.py",
    "backend/vibez/wisdom.py",
    "backend/vibez/author_classifier.py",
    "backend/vibez/chat_agent.py",
]
ROUTED_DASHBOARD_MODULES = [
    "dashboard/src/app/api/chat/route.ts",
    "dashboard/src/lib/catchup.ts",
    "dashboard/src/app/api/stats/topic/route.ts",
    "dashboard/src/app/api/wisdom/enhance/route.ts",
    "dashboard/src/app/api/contributions/route.ts",
]


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


def test_classify_missing_launchd_template_uses_shared_backfill_route():
    template = (ROOT / "launchd" / "com.vibez-monitor.classify-missing.plist").read_text()

    assert "--model" not in template
    assert "qwen2.5:3b" not in template
    assert "--task-id" in template
    assert "classification.backfill" in template


def test_routed_backend_modules_do_not_construct_provider_clients_directly():
    for relative_path in ROUTED_BACKEND_MODULES:
        source = (ROOT / relative_path).read_text()
        assert "Anthropic(" not in source
        assert "anthropic.Anthropic(" not in source
        assert "OpenAI(" not in source


def test_routed_dashboard_modules_do_not_construct_provider_clients_directly():
    for relative_path in ROUTED_DASHBOARD_MODULES:
        source = (ROOT / relative_path).read_text()
        assert "new Anthropic(" not in source
        assert "new OpenAI(" not in source
