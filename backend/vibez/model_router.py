"""Shared task-based model routing for backend inference."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


@dataclass(frozen=True)
class ModelRoute:
    provider: str
    model: str
    mode: str
    max_tokens: int
    temperature: float
    timeout_ms: int
    base_url: str | None = None
    dimensions: int | None = None


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
            dimensions=(
                int(raw_route["dimensions"])
                if raw_route.get("dimensions") is not None
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


def _build_messages(
    *,
    prompt: str | None,
    system: str | None,
    messages: list[dict[str, str]] | None,
) -> list[dict[str, str]]:
    if messages:
        return [
            {"role": str(message["role"]), "content": str(message["content"])}
            for message in messages
        ]
    if prompt is None:
        raise ValueError("prompt is required when messages are not supplied")
    payload: list[dict[str, str]] = []
    if system:
        payload.append({"role": "system", "content": system})
    payload.append({"role": "user", "content": prompt})
    return payload


def _usage_dict(usage: Any) -> dict[str, int]:
    if usage is None:
        return {"input_tokens": 0, "output_tokens": 0}
    return {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
    }


def _parse_json_output(raw: str) -> Any:
    text = raw.strip()
    fenced = text.startswith("```") and text.endswith("```")
    if fenced:
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


def _run_anthropic(
    route: ModelRoute,
    *,
    prompt: str | None,
    system: str | None,
    messages: list[dict[str, str]] | None,
) -> dict[str, Any]:
    import anthropic

    payload = _build_messages(prompt=prompt, system=None, messages=messages)
    with anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY")) as client:
        response = client.messages.create(
            model=route.model,
            max_tokens=route.max_tokens,
            system=system,
            messages=payload,
        )
    text = "\n".join(
        block.text.strip()
        for block in getattr(response, "content", []) or []
        if getattr(block, "text", None)
    ).strip()
    return {
        "text": text,
        "usage": _usage_dict(getattr(response, "usage", None)),
    }


def _run_openai(
    route: ModelRoute,
    *,
    prompt: str | None,
    system: str | None,
    messages: list[dict[str, str]] | None,
) -> dict[str, Any]:
    from openai import OpenAI

    payload = _build_messages(prompt=prompt, system=system, messages=messages)
    client = OpenAI(
        api_key=os.environ.get("OPENAI_API_KEY"),
        timeout=max(route.timeout_ms / 1000, 1),
    )
    response = client.responses.create(
        model=route.model,
        input=payload,
        max_output_tokens=route.max_tokens,
        temperature=route.temperature,
    )
    return {
        "text": getattr(response, "output_text", "") or "",
        "usage": _usage_dict(getattr(response, "usage", None)),
    }


def _embed_openai(
    route: ModelRoute,
    *,
    texts: list[str],
    dimensions: int | None = None,
) -> list[list[float]]:
    from openai import OpenAI

    client = OpenAI(
        api_key=os.environ.get("OPENAI_API_KEY"),
        timeout=max(route.timeout_ms / 1000, 1),
    )
    kwargs: dict[str, Any] = {
        "model": route.model,
        "input": texts,
        "encoding_format": "float",
    }
    resolved_dimensions = dimensions or route.dimensions
    if resolved_dimensions:
        kwargs["dimensions"] = resolved_dimensions
    response = client.embeddings.create(**kwargs)
    return [list(item.embedding) for item in response.data]


def _run_ollama(
    route: ModelRoute,
    *,
    prompt: str | None,
    system: str | None,
    messages: list[dict[str, str]] | None,
) -> dict[str, Any]:
    payload = _build_messages(prompt=prompt, system=system, messages=messages)
    base_url = route.base_url or os.environ.get("OLLAMA_BASE_URL")
    if not base_url:
        raise RuntimeError("OLLAMA_BASE_URL is required by model routing")
    endpoint = f"{base_url.rstrip('/')}/api/chat"
    response = httpx.post(
        endpoint,
        json={
            "model": route.model,
            "messages": payload,
            "stream": False,
            "options": {
                "temperature": route.temperature,
                "num_predict": route.max_tokens,
            },
            "format": "json" if route.mode == "json" else None,
        },
        timeout=max(route.timeout_ms / 1000, 1),
    )
    response.raise_for_status()
    data = response.json()
    return {
        "text": data.get("message", {}).get("content", "") or "",
        "usage": {
            "input_tokens": int(data.get("prompt_eval_count", 0) or 0),
            "output_tokens": int(data.get("eval_count", 0) or 0),
        },
    }


def generate_text(
    task_id: str,
    *,
    prompt: str | None = None,
    system: str | None = None,
    messages: list[dict[str, str]] | None = None,
    manifest_path: Path | str | None = None,
) -> dict[str, Any]:
    route = get_route(task_id, manifest_path)
    if route.provider == "anthropic":
        result = _run_anthropic(route, prompt=prompt, system=system, messages=messages)
    elif route.provider == "openai":
        result = _run_openai(route, prompt=prompt, system=system, messages=messages)
    elif route.provider == "ollama":
        result = _run_ollama(route, prompt=prompt, system=system, messages=messages)
    else:
        raise ValueError(f"unsupported model provider: {route.provider}")
    return {
        **result,
        "provider": route.provider,
        "model": route.model,
    }


def generate_json(
    task_id: str,
    *,
    prompt: str | None = None,
    system: str | None = None,
    messages: list[dict[str, str]] | None = None,
    manifest_path: Path | str | None = None,
) -> dict[str, Any]:
    result = generate_text(
        task_id,
        prompt=prompt,
        system=system,
        messages=messages,
        manifest_path=manifest_path,
    )
    return {
        **result,
        "parsed": _parse_json_output(result["text"]),
    }


def embed_texts(
    task_id: str,
    texts: list[str],
    *,
    dimensions: int | None = None,
    manifest_path: Path | str | None = None,
) -> list[list[float]]:
    route = get_route(task_id, manifest_path)
    if route.mode != "embedding":
        raise ValueError(f"task {task_id} is not an embedding route")
    if route.provider == "openai":
        return _embed_openai(route, texts=texts, dimensions=dimensions)
    raise ValueError(f"unsupported embedding provider: {route.provider}")


def embed_text(
    task_id: str,
    text: str,
    *,
    dimensions: int | None = None,
    manifest_path: Path | str | None = None,
) -> list[float]:
    vectors = embed_texts(
        task_id,
        [text],
        dimensions=dimensions,
        manifest_path=manifest_path,
    )
    return vectors[0] if vectors else []
