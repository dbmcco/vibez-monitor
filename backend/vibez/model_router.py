"""Shared task-based model routing for backend inference."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelRoute:
    provider: str
    model: str
    mode: str
    max_tokens: int
    temperature: float
    timeout_ms: int
    base_url: str | None = None


def default_manifest_path() -> Path:
    return Path("config/model-routing.json")


def _resolve_manifest_path(manifest_path: Path | str | None = None) -> Path:
    path = Path(manifest_path) if manifest_path is not None else default_manifest_path()
    if path.is_absolute():
        return path
    cwd_path = Path.cwd() / path
    if cwd_path.exists():
        return cwd_path
    return Path(__file__).resolve().parents[2] / path


def load_routes(manifest_path: Path | str | None = None) -> dict[str, ModelRoute]:
    path = _resolve_manifest_path(manifest_path)
    payload = json.loads(path.read_text())
    if payload.get("version") != 1:
        raise ValueError(f"unsupported model routing manifest version: {payload.get('version')}")
    routes_raw = payload.get("routes")
    if not isinstance(routes_raw, dict):
        raise ValueError("model routing manifest must include a routes object")

    routes: dict[str, ModelRoute] = {}
    for task_id, raw_route in routes_raw.items():
        if not isinstance(raw_route, dict):
            raise ValueError(f"route {task_id} must be an object")
        routes[task_id] = ModelRoute(
            provider=str(raw_route["provider"]),
            model=str(raw_route["model"]),
            mode=str(raw_route["mode"]),
            max_tokens=int(raw_route["max_tokens"]),
            temperature=float(raw_route["temperature"]),
            timeout_ms=int(raw_route["timeout_ms"]),
            base_url=(
                str(raw_route["base_url"])
                if raw_route.get("base_url") is not None
                else None
            ),
        )
    return routes


def get_route(task_id: str, manifest_path: Path | str | None = None) -> ModelRoute:
    routes = load_routes(manifest_path)
    if task_id not in routes:
        raise KeyError(f"unknown model route: {task_id}")
    return routes[task_id]


def validate_route_requirements(manifest_path: Path | str | None = None) -> None:
    for route in load_routes(manifest_path).values():
        if route.provider == "openai" and not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is required by model routing")
        if route.provider == "anthropic" and not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is required by model routing")
        if route.provider == "ollama" and not (
            route.base_url or os.environ.get("OLLAMA_BASE_URL")
        ):
            raise RuntimeError("OLLAMA_BASE_URL is required by model routing")
