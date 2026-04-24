import json
from pathlib import Path

import pytest

from vibez.model_router import (
    ModelRoute,
    get_route,
    load_routes,
    validate_route_requirements,
)

ROOT = Path(__file__).resolve().parents[2]
REQUIRED_TASK_IDS = {
    "embedding.semantic",
    "classification.inline",
    "classification.backfill",
    "synthesis.daily",
    "wisdom.extract",
    "wisdom.summarize",
    "links.author_enrichment",
    "chat.interactive",
    "dashboard.catchup",
    "dashboard.topic_analysis",
    "dashboard.wisdom_enhance",
    "dashboard.contributions",
}


def test_load_routes_reads_shared_manifest(tmp_path: Path):
    manifest = tmp_path / "model-routing.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": {
                    "classification.inline": {
                        "provider": "openai",
                        "model": "gpt-5-mini",
                        "mode": "json",
                        "max_tokens": 256,
                        "temperature": 0.1,
                        "timeout_ms": 30000,
                    },
                    "embedding.semantic": {
                        "provider": "openai",
                        "model": "text-embedding-3-small",
                        "mode": "embedding",
                        "max_tokens": 0,
                        "temperature": 0,
                        "timeout_ms": 30000,
                        "dimensions": 256,
                    }
                },
            }
        )
    )

    routes = load_routes(manifest)

    assert routes["classification.inline"] == ModelRoute(
        provider="openai",
        model="gpt-5-mini",
        mode="json",
        max_tokens=256,
        temperature=0.1,
        timeout_ms=30000,
        base_url=None,
        dimensions=None,
    )
    assert routes["embedding.semantic"] == ModelRoute(
        provider="openai",
        model="text-embedding-3-small",
        mode="embedding",
        max_tokens=0,
        temperature=0,
        timeout_ms=30000,
        base_url=None,
        dimensions=256,
    )


def test_get_route_raises_for_unknown_task(tmp_path: Path):
    manifest = tmp_path / "model-routing.json"
    manifest.write_text('{"version":1,"routes":{}}')

    with pytest.raises(KeyError, match="unknown model route: chat.interactive"):
        get_route("chat.interactive", manifest)


def test_validate_route_requirements_only_requires_used_provider_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manifest = tmp_path / "model-routing.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": {
                    "classification.inline": {
                        "provider": "openai",
                        "model": "gpt-5-mini",
                        "mode": "json",
                        "max_tokens": 256,
                        "temperature": 0.1,
                        "timeout_ms": 30000,
                    },
                    "embedding.semantic": {
                        "provider": "openai",
                        "model": "text-embedding-3-small",
                        "mode": "embedding",
                        "max_tokens": 0,
                        "temperature": 0,
                        "timeout_ms": 30000,
                        "dimensions": 256,
                    }
                },
            }
        )
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test")

    validate_route_requirements(manifest)


def test_shared_manifest_contains_required_task_routes():
    routes = load_routes(ROOT / "config" / "model-routing.json")

    assert REQUIRED_TASK_IDS.issubset(routes)
    assert routes["classification.backfill"].provider == "ollama"
    assert routes["classification.backfill"].model == "hermes3:8b"
