# Central Model Routing — Design Document

## Goal

Introduce one task-level model routing control plane for Vibez so both the Python background jobs and the Next.js server routes use the same provider, model, endpoint, response mode, and timeout policy.

## Problem

Vibez currently routes model calls feature-by-feature instead of task-by-task:

- backend feature modules instantiate Anthropic directly
- the backfill worker talks to Ollama directly
- dashboard server routes instantiate Anthropic directly
- launchd templates still pin stale model names outside the app code

That makes routing drift inevitable. Operators cannot answer simple questions like "what model is powering wisdom right now?" without reading multiple files, and changing provider or model behavior requires touching unrelated modules.

## Current Routing Inventory

### Backend

Direct provider calls currently live in:
- `backend/vibez/classifier.py`
- `backend/vibez/synthesis.py`
- `backend/vibez/chat_agent.py`
- `backend/vibez/wisdom.py`
- `backend/vibez/author_classifier.py`
- `backend/scripts/classify_backfill.py`
- `backend/scripts/run_wisdom.py`

Routing configuration currently lives partly in:
- `backend/vibez/config.py`
- `launchd/com.vibez-monitor.classify-missing.plist`

### Dashboard

Direct provider calls currently live in:
- `dashboard/src/app/api/chat/route.ts`
- `dashboard/src/app/api/contributions/route.ts`
- `dashboard/src/app/api/stats/topic/route.ts`
- `dashboard/src/app/api/wisdom/enhance/route.ts`
- `dashboard/src/lib/catchup.ts`

## Decision

Use a shared routing manifest with thin runtime adapters.

This is the smallest design that:
- gives one source of truth for routing policy
- works across Python and Next.js without a new service
- lets us change providers or models without reopening feature modules
- closes the current split-brain between local jobs, Railway routes, and launchd helpers

## Non-Goals

This first pass does not include:
- new operator UI
- embeddings routing
- automatic provider failover
- prompt redesign
- a central HTTP gateway

## Desired End State

After this change:

- every model-backed feature asks for a named task route, not a provider SDK
- routing policy lives in one manifest
- the backend and dashboard validate the same manifest shape
- background jobs and launchd templates stop carrying hidden provider/model policy
- operators can inspect one file and know which provider/model each task uses

## Proposed Architecture

### Shared Manifest

Create `config/model-routing.json` as the single routing source of truth.

Initial shape:

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
    }
  }
}
```

JSON is the right first-pass format because:
- Python and TypeScript can parse it without new dependencies
- it is easy to validate in tests
- it keeps the control plane explicit and diff-friendly

### Stable Task IDs

The manifest should route named tasks, not files. First-pass task set:

- `classification.inline`
- `classification.backfill`
- `synthesis.daily`
- `wisdom.extract`
- `wisdom.summarize`
- `links.author_enrichment`
- `chat.interactive`
- `dashboard.catchup`
- `dashboard.topic_analysis`
- `dashboard.wisdom_enhance`
- `dashboard.contributions`

These IDs are the public contract for routing. Files may change later; task names should stay stable.

### Python Adapter

Add `backend/vibez/model_router.py`.

Responsibilities:
- load and cache the manifest
- validate route existence and required fields
- resolve provider credentials and base URLs
- expose two narrow entrypoints:
  - `generate_text(...)`
  - `generate_json(...)`
- normalize provider responses into one result shape with text and usage

Feature modules should stop importing provider SDKs directly. They should only:
- build system prompt / user prompt
- choose the task ID
- call the router

### Next.js Adapter

Add `dashboard/src/lib/model-router.ts`.

Responsibilities mirror the Python adapter:
- load the same JSON manifest
- validate route definitions
- create provider clients at the edge of the adapter
- expose:
  - `generateText(...)`
  - `generateJson(...)`

Dashboard route files should no longer import provider SDKs directly.

### Provider Surface

Support three adapters in v1:
- `openai`
- `anthropic`
- `ollama`

The interface stays intentionally narrow:
- text generation
- JSON generation

No embeddings, no multimodal surface, no automatic fallback logic.

## Initial Routing Policy

This migration should also collapse the current cost ambiguity into explicit policy:

- cheap structured/background tasks default to `openai:gpt-5-mini`
- long-form synthesis defaults to `openai:gpt-5.1`
- local backfill remains on `ollama:qwen3:8b`
- Anthropic remains supported by the router, but not as the default for the core routes above

That gives us one migration that fixes both routing drift and the current Anthropic cost bias.

## Config Changes

`backend/vibez/config.py` should stop requiring Anthropic unconditionally.

Needed config additions:
- `model_routing_path`
- `openai_api_key`
- `anthropic_api_key` becomes optional
- `ollama_base_url`

Validation should be route-aware:
- if no configured route uses Anthropic, missing `ANTHROPIC_API_KEY` should not fail startup
- if a route uses OpenAI, missing `OPENAI_API_KEY` should fail loudly
- if a route uses Ollama, the route should require a base URL and fail clearly when missing

## Migration Rules

The migration must satisfy all of these:

1. No direct provider client construction in migrated feature modules.
2. Launchd templates must not pin stale model names that disagree with the manifest.
3. `run_wisdom.py` and `classify_backfill.py` must use task IDs instead of owning routing policy.
4. Both runtimes must validate the same manifest contract in tests.
5. The router must fail loudly on unknown routes or missing credentials. No silent fallback.

## Testing Strategy

### Backend

Add:
- router manifest loading tests
- provider option validation tests
- config tests for optional provider credentials
- migration tests for classifier / synthesis / wisdom call sites
- runtime contract test that targeted modules no longer instantiate provider SDKs directly

### Dashboard

Add:
- manifest parsing tests
- router unit tests for route lookup and validation
- route-level tests for chat/catchup/wisdom helpers using the shared router
- build verification to ensure the server bundle still resolves the manifest path

### Operational

Verify:
- local jobs run through routed task IDs
- Railway server routes run through routed task IDs
- launchd uses supported task-model values
- wisdom, briefing, and chat still update after the migration

## Rollout

1. Add the manifest and both runtime adapters.
2. Migrate backend routes and jobs to task IDs.
3. Migrate dashboard routes to task IDs.
4. Update launchd/runtime contract tests so stale direct paths cannot reappear.
5. Verify local and Railway behavior using the same manifest policy.

## Open Follow-Ups

- add operator-facing status for effective route selection if needed later
- decide whether to route embeddings through the same control plane
- decide whether interactive chat should remain on the same model as background synthesis
