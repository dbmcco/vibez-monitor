# Central Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current feature-by-feature provider wiring with one shared task-level model routing system used by both the backend and the dashboard.

**Architecture:** Add a repo-level JSON routing manifest plus one thin adapter per runtime. The backend and dashboard will call named task routes like `classification.inline` or `chat.interactive`, while provider SDKs stay confined to the router layers. Runtime and launchd drift are closed by moving stale hardcoded model policy into the manifest and adding tests that prevent direct provider calls from returning.

**Tech Stack:** Python 3.12, TypeScript, Next.js 16, SQLite, `openai`, `anthropic`, `httpx`, `better-sqlite3`, Vitest, pytest, Workgraph/Driftdriver.

---

### File Structure Map

- `config/model-routing.json`: single source of truth for task routing
- `backend/vibez/model_router.py`: backend route loading, validation, and provider execution
- `backend/vibez/config.py`: optional provider credentials plus manifest path
- `backend/tests/test_model_router.py`: backend router contract and validation tests
- `backend/tests/test_config.py`: config behavior for optional provider credentials
- `backend/vibez/classifier.py`: inline classification routed through `classification.inline`
- `backend/vibez/synthesis.py`: daily synthesis routed through `synthesis.daily`
- `backend/vibez/wisdom.py`: wisdom extraction/summarization routed through `wisdom.extract` and `wisdom.summarize`
- `backend/vibez/author_classifier.py`: link author inference routed through `links.author_enrichment`
- `backend/vibez/chat_agent.py`: backend chat agent routed through `chat.interactive`
- `backend/scripts/run_wisdom.py`: batch CLI selects task IDs instead of provider-specific CLI policy
- `backend/scripts/classify_backfill.py`: backfill worker resolves `classification.backfill` from the manifest
- `backend/tests/test_classifier.py`, `backend/tests/test_wisdom.py`, `backend/tests/test_synthesis.py`: migration tests for routed backend paths
- `backend/tests/test_runtime_contracts.py`: regression tests against stale direct-routing paths
- `backend/pyproject.toml`: add backend OpenAI dependency
- `dashboard/src/lib/model-router.ts`: dashboard route loading, validation, and provider execution
- `dashboard/src/lib/model-router.test.ts`: dashboard router contract tests
- `dashboard/src/app/api/chat/route.ts`: route through `chat.interactive`
- `dashboard/src/lib/catchup.ts`: route through `dashboard.catchup`
- `dashboard/src/app/api/stats/topic/route.ts`: route through `dashboard.topic_analysis`
- `dashboard/src/app/api/wisdom/enhance/route.ts`: route through `dashboard.wisdom_enhance`
- `dashboard/src/app/api/contributions/route.ts`: route through `dashboard.contributions`
- `dashboard/package.json`: add dashboard OpenAI dependency
- `launchd/com.vibez-monitor.classify-missing.plist`: remove stale `qwen2.5:3b` drift

### Task 1: Add The Shared Routing Manifest And Backend Router

**Files:**
- Create: `config/model-routing.json`
- Create: `backend/vibez/model_router.py`
- Create: `backend/tests/test_model_router.py`
- Modify: `backend/vibez/config.py`
- Modify: `backend/tests/test_config.py`
- Modify: `backend/pyproject.toml`

- [ ] **Step 1: Write the failing backend router tests**

```python
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


def test_validate_route_requirements_only_requires_used_provider_keys(tmp_path: Path, monkeypatch):
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
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_model_router.py backend/tests/test_config.py -q
```

Expected: FAIL because the router module, manifest, and route-aware config validation do not exist yet.

- [ ] **Step 3: Add the manifest, backend router, and config wiring**

`config/model-routing.json`

```json
{
  "version": 1,
  "routes": {
    "classification.inline": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "json",
      "max_tokens": 256,
      "temperature": 0.1,
      "timeout_ms": 30000
    },
    "classification.backfill": {
      "provider": "ollama",
      "model": "qwen3:8b",
      "mode": "json",
      "base_url": "http://localhost:11434",
      "max_tokens": 256,
      "temperature": 0.1,
      "timeout_ms": 120000
    },
    "synthesis.daily": {
      "provider": "openai",
      "model": "gpt-5.1",
      "mode": "text",
      "max_tokens": 8192,
      "temperature": 0.2,
      "timeout_ms": 120000
    },
    "wisdom.extract": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "json",
      "max_tokens": 2048,
      "temperature": 0.1,
      "timeout_ms": 120000
    },
    "wisdom.summarize": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "text",
      "max_tokens": 256,
      "temperature": 0.1,
      "timeout_ms": 120000
    },
    "links.author_enrichment": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "json",
      "max_tokens": 256,
      "temperature": 0.1,
      "timeout_ms": 30000
    },
    "chat.interactive": {
      "provider": "openai",
      "model": "gpt-5.1",
      "mode": "text",
      "max_tokens": 1024,
      "temperature": 0.2,
      "timeout_ms": 60000
    },
    "dashboard.catchup": {
      "provider": "openai",
      "model": "gpt-5.1",
      "mode": "json",
      "max_tokens": 4096,
      "temperature": 0.2,
      "timeout_ms": 120000
    },
    "dashboard.topic_analysis": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "json",
      "max_tokens": 1024,
      "temperature": 0.1,
      "timeout_ms": 60000
    },
    "dashboard.wisdom_enhance": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "text",
      "max_tokens": 1024,
      "temperature": 0.2,
      "timeout_ms": 60000
    },
    "dashboard.contributions": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "mode": "json",
      "max_tokens": 1024,
      "temperature": 0.1,
      "timeout_ms": 60000
    }
  }
}
```

`backend/vibez/model_router.py`

```python
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anthropic
import httpx
from openai import OpenAI


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
    return Path(__file__).resolve().parents[2] / "config" / "model-routing.json"


def load_routes(manifest_path: Path | None = None) -> dict[str, ModelRoute]:
    path = manifest_path or default_manifest_path()
    payload = json.loads(path.read_text())
    routes = {}
    for task_id, raw in payload["routes"].items():
        routes[task_id] = ModelRoute(**raw)
    return routes


def get_route(task_id: str, manifest_path: Path | None = None) -> ModelRoute:
    routes = load_routes(manifest_path)
    if task_id not in routes:
        raise KeyError(f"unknown model route: {task_id}")
    return routes[task_id]


def validate_route_requirements(manifest_path: Path | None = None) -> None:
    for route in load_routes(manifest_path).values():
        if route.provider == "openai" and not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is required by model routing")
        if route.provider == "anthropic" and not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is required by model routing")
        if route.provider == "ollama" and not (route.base_url or os.environ.get("OLLAMA_BASE_URL")):
            raise RuntimeError("OLLAMA_BASE_URL is required by model routing")
```

`backend/vibez/config.py`

```python
@dataclass
class Config:
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    model_routing_path: Path = field(
        default_factory=lambda: Path(__file__).resolve().parents[2] / "config" / "model-routing.json"
    )
    ollama_base_url: str = "http://localhost:11434"
```

- [ ] **Step 4: Run the backend router tests again**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_model_router.py backend/tests/test_config.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the routing foundation**

```bash
git add config/model-routing.json backend/vibez/model_router.py backend/vibez/config.py backend/tests/test_model_router.py backend/tests/test_config.py backend/pyproject.toml
git commit -m "feat: add shared model routing foundation"
```

### Task 2: Migrate Backend Inference Paths To Named Routes

**Files:**
- Modify: `backend/vibez/classifier.py`
- Modify: `backend/vibez/synthesis.py`
- Modify: `backend/vibez/wisdom.py`
- Modify: `backend/vibez/author_classifier.py`
- Modify: `backend/vibez/chat_agent.py`
- Modify: `backend/scripts/run_wisdom.py`
- Modify: `backend/scripts/classify_backfill.py`
- Modify: `backend/tests/test_classifier.py`
- Modify: `backend/tests/test_synthesis.py`
- Modify: `backend/tests/test_wisdom.py`

- [ ] **Step 1: Add failing backend migration tests**

`backend/tests/test_classifier.py`

```python
async def test_classify_messages_uses_named_route(tmp_db, monkeypatch):
    captured = {}

    async def fake_generate_json(*, task_id: str, **_kwargs):
        captured["task_id"] = task_id
        return {
            "parsed": {
                "relevance_score": 7,
                "topics": ["ai-models"],
                "entities": ["Claude"],
                "contribution_flag": False,
                "contribution_themes": [],
                "contribution_hint": "",
                "alert_level": "digest",
            },
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "model": "gpt-5-mini",
        }

    monkeypatch.setattr("vibez.classifier.generate_json", fake_generate_json)
    ...
    assert captured["task_id"] == "classification.inline"
```

`backend/tests/test_wisdom.py`

```python
def test_classify_chunk_uses_wisdom_extract_route(monkeypatch):
    captured = {}

    def fake_generate_json(*, task_id: str, **_kwargs):
        captured["task_id"] = task_id
        return {"parsed": []}

    monkeypatch.setattr("vibez.wisdom.generate_json", fake_generate_json)

    assert classify_chunk([{"room_name": "Show and Tell", "sender_name": "A", "body": "Hi"}]) == []
    assert captured["task_id"] == "wisdom.extract"
```

- [ ] **Step 2: Run the failing backend migration tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_classifier.py backend/tests/test_wisdom.py backend/tests/test_synthesis.py -q
```

Expected: FAIL because the backend modules still import and instantiate provider SDKs directly.

- [ ] **Step 3: Replace direct provider calls with router calls**

`backend/vibez/classifier.py`

```python
from vibez.model_router import generate_json

...

result = await generate_json(
    task_id="classification.inline",
    system=CLASSIFY_SYSTEM_TEMPLATE.format(
        subject_name=subject_name,
        subject_possessive=subject_possessive,
    ),
    prompt=prompt,
    manifest_path=config.model_routing_path,
)
classification = parse_classification(json.dumps(result["parsed"]))
record_usage(
    config.db_path,
    result["model"],
    result["usage"]["input_tokens"],
    result["usage"]["output_tokens"],
)
```

`backend/vibez/wisdom.py`

```python
from vibez.model_router import generate_json, generate_text

...

result = generate_json(
    task_id="wisdom.extract",
    system=CLASSIFICATION_SYSTEM,
    prompt=prompt,
)
items = result["parsed"] if isinstance(result["parsed"], list) else []

summary = generate_text(
    task_id="wisdom.summarize",
    prompt=CONSENSUS_PROMPT.format(topic=topic_name, items=items_text),
)
```

`backend/scripts/classify_backfill.py`

```python
from vibez.model_router import generate_json, get_route

route = get_route("classification.backfill")
assert route.provider == "ollama"
...
result = await generate_json(
    task_id="classification.backfill",
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ],
)
classification = parse_classification(json.dumps(result["parsed"]))
```

- [ ] **Step 4: Run the backend migration tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_classifier.py backend/tests/test_wisdom.py backend/tests/test_synthesis.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the backend migration**

```bash
git add backend/vibez/classifier.py backend/vibez/synthesis.py backend/vibez/wisdom.py backend/vibez/author_classifier.py backend/vibez/chat_agent.py backend/scripts/run_wisdom.py backend/scripts/classify_backfill.py backend/tests/test_classifier.py backend/tests/test_synthesis.py backend/tests/test_wisdom.py
git commit -m "refactor: route backend inference through shared model router"
```

### Task 3: Add The Dashboard Router And Migrate Server Routes

**Files:**
- Create: `dashboard/src/lib/model-router.ts`
- Create: `dashboard/src/lib/model-router.test.ts`
- Modify: `dashboard/src/app/api/chat/route.ts`
- Modify: `dashboard/src/lib/catchup.ts`
- Modify: `dashboard/src/app/api/stats/topic/route.ts`
- Modify: `dashboard/src/app/api/wisdom/enhance/route.ts`
- Modify: `dashboard/src/app/api/contributions/route.ts`
- Modify: `dashboard/package.json`

- [ ] **Step 1: Write the failing dashboard router tests**

`dashboard/src/lib/model-router.test.ts`

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { getRoute, loadRoutes } from "./model-router";

describe("model-router", () => {
  test("loads the shared routing manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-"));
    const manifestPath = path.join(dir, "model-routing.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        routes: {
          "chat.interactive": {
            provider: "openai",
            model: "gpt-5.1",
            mode: "text",
            max_tokens: 1024,
            temperature: 0.2,
            timeout_ms: 60000,
          },
        },
      }),
    );

    const routes = loadRoutes(manifestPath);

    expect(routes["chat.interactive"]).toMatchObject({
      provider: "openai",
      model: "gpt-5.1",
      mode: "text",
    });
  });

  test("throws on unknown task ids", () => {
    expect(() => getRoute("dashboard.catchup", {})).toThrow(
      "unknown model route: dashboard.catchup",
    );
  });
});
```

- [ ] **Step 2: Run the failing dashboard tests**

Run:

```bash
cd dashboard && npm run test:unit -- model-router.test.ts
```

Expected: FAIL because the dashboard router does not exist yet.

- [ ] **Step 3: Add the dashboard router and migrate the routes**

`dashboard/src/lib/model-router.ts`

```ts
import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface ModelRoute {
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  mode: "text" | "json";
  max_tokens: number;
  temperature: number;
  timeout_ms: number;
  base_url?: string;
}

export function defaultManifestPath(): string {
  return process.env.VIBEZ_MODEL_ROUTING_PATH ||
    path.join(process.cwd(), "..", "config", "model-routing.json");
}

export function loadRoutes(manifestPath = defaultManifestPath()): Record<string, ModelRoute> {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).routes;
}

export function getRoute(taskId: string, routes = loadRoutes()): ModelRoute {
  const route = routes[taskId];
  if (!route) throw new Error(`unknown model route: ${taskId}`);
  return route;
}
```

`dashboard/src/app/api/chat/route.ts`

```ts
import { generateText } from "@/lib/model-router";

...

const result = await generateText({
  taskId: "chat.interactive",
  system: systemPrompt,
  prompt,
});
const visibleAnswer = wantsLinks ? makeUrlsVisible(result.text) : result.text;
```

`dashboard/src/lib/catchup.ts`

```ts
import { generateJson } from "@/lib/model-router";

...

const result = await generateJson<CatchupResult>({
  taskId: "dashboard.catchup",
  prompt: buildCatchupPrompt(reports, startDate, endDate),
});
return result.parsed;
```

- [ ] **Step 4: Run dashboard tests and build verification**

Run:

```bash
cd dashboard && npm run test:unit -- model-router.test.ts push-ingest.test.ts
cd dashboard && npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the dashboard migration**

```bash
git add dashboard/src/lib/model-router.ts dashboard/src/lib/model-router.test.ts dashboard/src/app/api/chat/route.ts dashboard/src/lib/catchup.ts dashboard/src/app/api/stats/topic/route.ts dashboard/src/app/api/wisdom/enhance/route.ts dashboard/src/app/api/contributions/route.ts dashboard/package.json
git commit -m "refactor: route dashboard AI paths through shared model router"
```

### Task 4: Remove Stale Runtime Drift And Add Guardrails

**Files:**
- Modify: `launchd/com.vibez-monitor.classify-missing.plist`
- Modify: `backend/tests/test_runtime_contracts.py`
- Modify: `backend/tests/test_model_router.py`

- [ ] **Step 1: Add failing runtime contract tests**

`backend/tests/test_runtime_contracts.py`

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_classify_missing_launchd_does_not_pin_removed_qwen_model():
    template = (ROOT / "launchd" / "com.vibez-monitor.classify-missing.plist").read_text()

    assert "qwen2.5:3b" not in template
    assert "qwen3:8b" in template


def test_migrated_modules_do_not_instantiate_provider_sdks_directly():
    banned = {
        "backend/vibez/classifier.py": "anthropic.Anthropic(",
        "backend/vibez/synthesis.py": "anthropic.Anthropic(",
        "backend/vibez/wisdom.py": "Anthropic(",
        "dashboard/src/app/api/chat/route.ts": "new Anthropic(",
        "dashboard/src/lib/catchup.ts": "new Anthropic(",
    }

    for relative_path, needle in banned.items():
        text = (ROOT / relative_path).read_text()
        assert needle not in text
```

- [ ] **Step 2: Run the failing runtime contract tests**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_runtime_contracts.py -q
```

Expected: FAIL until the runtime drift is removed.

- [ ] **Step 3: Update the launchd template and guardrails**

`launchd/com.vibez-monitor.classify-missing.plist`

```xml
<string>--model</string>
<string>qwen3:8b</string>
```

`backend/tests/test_model_router.py`

```python
def test_manifest_contains_required_v1_task_ids():
    routes = load_routes()
    assert {
        "classification.inline",
        "classification.backfill",
        "synthesis.daily",
        "wisdom.extract",
        "wisdom.summarize",
        "chat.interactive",
        "dashboard.catchup",
    }.issubset(routes)
```

- [ ] **Step 4: Run the contract tests again**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_runtime_contracts.py backend/tests/test_model_router.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the runtime hardening**

```bash
git add launchd/com.vibez-monitor.classify-missing.plist backend/tests/test_runtime_contracts.py backend/tests/test_model_router.py
git commit -m "test: guard shared routing against stale runtime drift"
```

### Task 5: Verify End-To-End Routing And Ship

**Files:**
- Modify: `docs/plans/2026-04-17-central-model-routing-design.md`
- Modify: `docs/plans/2026-04-17-central-model-routing-plan.md`

- [ ] **Step 1: Run the backend verification suite**

Run:

```bash
backend/.venv/bin/python -m pytest \
  backend/tests/test_model_router.py \
  backend/tests/test_config.py \
  backend/tests/test_classifier.py \
  backend/tests/test_synthesis.py \
  backend/tests/test_wisdom.py \
  backend/tests/test_runtime_contracts.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the dashboard verification suite**

Run:

```bash
cd dashboard && npm run test:unit -- model-router.test.ts push-ingest.test.ts
cd dashboard && npm run build
```

Expected: PASS.

- [ ] **Step 3: Run a direct inventory check for accidental direct-call regressions**

Run:

```bash
rg -n "Anthropic\\(|new Anthropic\\(|http://localhost:11434/api/chat|CLASSIFIER_MODEL|SYNTHESIS_MODEL" backend dashboard launchd -g '!**/node_modules/**'
```

Expected: only router modules, manifest-aware config code, and intentional compatibility shims appear.

- [ ] **Step 4: Record the final manifest-driven rollout docs**

```md
- local and Railway routes now resolve task IDs from `config/model-routing.json`
- stale direct provider paths are removed from migrated modules
- launchd backfill uses the supported `qwen3:8b` route baseline
```

- [ ] **Step 5: Commit, rebase, and push**

```bash
git add docs/plans/2026-04-17-central-model-routing-design.md docs/plans/2026-04-17-central-model-routing-plan.md
git commit -m "docs: add central model routing design and implementation plan"
git pull --rebase
git push
git status
```

Expected: `git status` shows `Your branch is up to date with 'origin/main'.`

---

## Self-Review

### Spec Coverage

- Shared routing manifest: covered in Task 1
- Thin backend and dashboard adapters: covered in Tasks 1 and 3
- Migration of live backend and dashboard routes: covered in Tasks 2 and 3
- Launchd / stale runtime drift: covered in Task 4
- Validation and regression prevention: covered in Tasks 1, 4, and 5

### Placeholder Scan

- No `TBD` or `TODO` markers remain
- Every task names concrete files and commands
- Every code-writing step includes a concrete snippet

### Type Consistency

- Stable route IDs are reused consistently across design and plan
- Manifest path is `config/model-routing.json` in both runtimes
- Router surface stays `generate_text` / `generate_json` in Python and `generateText` / `generateJson` in TypeScript

## Execution Handoff

Plan complete and saved to `docs/plans/2026-04-17-central-model-routing-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
