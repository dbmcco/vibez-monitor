import json
from pathlib import Path

import pytest

from vibez.model_router import (
    ModelRoute,
    get_route,
    load_routes,
    validate_route_requirements,
)


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
                    }
                },
            }
        )
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test")

    validate_route_requirements(manifest)
