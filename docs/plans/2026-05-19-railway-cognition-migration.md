# Railway Cognition Migration Plan

Date: 2026-05-19
Status: Speedrift implementation plan

## Objective

Make the local Mac a Beeper/WhatsApp capture adapter only, and make Railway the canonical system for storage, embeddings, classification, Atlas publishing, research dives, images, stats, links, and member enrichment.

This removes the local/Railway split that caused edition drift. Railway Postgres becomes the source of truth. Local state becomes a retryable source spool, not an alternate processing pipeline.

## Architecture

```text
Local Mac
  Beeper session
  Raw export
  Append-only local spool
  Idempotent batch push

Railway
  Authenticated ingest API
  Canonical Postgres + pgvector
  Raw events + watermarks + ingest batches
  Links/members/stats extraction
  OpenRouter embeddings
  OpenRouter classification
  Atlas editorial writing
  Image generation
  Durable editions and assets
  App read path
```

## Model Ownership

Local code may only do mechanical capture work:

- read Beeper exports
- normalize source IDs, timestamps, room IDs, sender IDs, body, links, and attachments
- write local spool batches
- retry delivery
- exact dedupe by source event key before push

Local code must not do semantic work:

- no embeddings
- no theme classification
- no relevance scoring
- no value assessment
- no Atlas writing
- no image generation
- no edition publishing

Railway owns model-mediated work. Code validates schemas, persists artifacts, tracks prompt/model versions, and fails visibly when model work fails. Code must not silently replace model judgment with deterministic fallback prose or labels.

## Model Routes

All routes must resolve through the central registry in:

`/Users/braydon/projects/experiments/paia-agent-runtime/config/cognition-presets.toml`

Application code should not hardcode model IDs, provider defaults, fallback order, base URLs, or credential environment variables. The local app manifest may remain as a compatibility adapter only until the registry-backed resolver replaces it.

### Selected Routes

| Capability | Primary | Quality / Evaluation | Notes |
|---|---|---|---|
| Atlas writing | `z-ai/glm-5.1` via OpenRouter | existing writer eval set | Already the best current writer route for cost/quality. |
| Embedding fast | `perplexity/pplx-embed-v1-0.6b` via OpenRouter embeddings | `qwen/qwen3-embedding-8b` | Perplexity smoke test: 1024 dimensions, 32k context, about $0.004 / 1M tokens. |
| Embedding fallback | `openai/text-embedding-3-small` | n/a | Stable hosted fallback if OpenRouter embedding route fails evaluation. |
| Classification fast | `mistralai/mistral-nemo` via OpenRouter | `qwen/qwen3-235b-a22b-2507` | Cheap structured output first; escalate only for quality-sensitive batch repair/eval. |
| Research dive synthesis | `z-ai/glm-5.1` or existing high-quality route | prompt/version eval | Cache outputs per edition/article. |

### Registry Work

Add a provider surface:

```toml
[provider_surfaces.openrouter_embedding]
provider = "openrouter"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
start_timeout_seconds = 60
tool_start_timeout_seconds = 60
continue_timeout_seconds = 60
complete_timeout_seconds = 60
```

Add Vibez routes:

```toml
[model_routes."vibez.embedding_fast"]
surface = "openrouter_embedding"
provider = "openrouter"
model = "perplexity/pplx-embed-v1-0.6b"
quality_tier = "embedding_fast"

[model_routes."vibez.embedding_quality"]
surface = "openrouter_embedding"
provider = "openrouter"
model = "qwen/qwen3-embedding-8b"
quality_tier = "embedding_quality"

[model_routes."vibez.embedding_fallback"]
surface = "openai_embedding_small"
provider = "openai"
model = "text-embedding-3-small"
quality_tier = "embedding_fallback"

[model_routes."vibez.classification_fast"]
surface = "openrouter"
provider = "openrouter"
model = "mistralai/mistral-nemo"
quality_tier = "classification_fast"

[model_routes."vibez.classification_quality"]
surface = "openrouter"
provider = "openrouter"
model = "qwen/qwen3-235b-a22b-2507"
quality_tier = "classification_quality"
```

## Database Migration

Add or extend Railway Postgres tables:

- `ingest_batches`
  - `id`, `source`, `batch_key`, `started_at`, `completed_at`, `status`, `record_count`, `inserted_count`, `deduped_count`, `error`
  - unique `(source, batch_key)`

- `source_watermarks`
  - `source`, `room_id`, `latest_source_event_id`, `latest_source_timestamp`, `last_successful_batch_id`, `updated_at`
  - unique `(source, room_id)`

- `raw_events`
  - `id`, `source`, `source_event_key`, `source_room_id`, `room_name`, `sender_key`, `sender_display_name`, `source_timestamp`, `body`, `attachments_json`, `raw_payload_json`, `body_hash`, `created_at`
  - unique `(source, source_event_key)`

- `raw_event_links`
  - `raw_event_id`, `url`, `normalized_url`, `host`, `position`, `created_at`

- `message_embeddings`
  - `raw_event_id`, `route_id`, `model`, `dimensions`, `text_hash`, `embedding vector`, `created_at`, `updated_at`
  - unique `(raw_event_id, route_id, text_hash)`

- `model_classifications`
  - `raw_event_id`, `route_id`, `model`, `prompt_version`, `schema_version`, `classification_json`, `evidence_json`, `created_at`, `updated_at`
  - unique `(raw_event_id, route_id, prompt_version, schema_version)`

Existing tables for links, stats, members, Atlas editions, and assets should be migrated to read from canonical `raw_events` and these model artifact tables.

## Execution Phases

### Phase 0: Registry And Resolver

1. Add `openrouter_embedding` provider surface to the central registry.
2. Add Vibez embedding/classification routes.
3. Replace app-local route ownership with a registry-backed adapter.
4. Add route smoke tests for:
   - Perplexity 0.6B embeddings
   - Mistral Nemo JSON classification
   - GLM-5.1 Atlas writing route

Acceptance:

- No new model IDs or provider credentials are hardcoded in app code.
- `embedTexts` can call OpenRouter `/embeddings`.
- Existing model-router tests pass.

### Phase 1: Railway Ingest API And Canonical Raw Events

1. Add authenticated `POST /api/ingest/beeper/batch`.
2. Create `ingest_batches`, `source_watermarks`, `raw_events`, and `raw_event_links`.
3. Make ingestion idempotent by `(source, source_event_key)`.
4. Return inserted/deduped/error counts.

Acceptance:

- Replaying the same batch twice creates no duplicate events.
- Batch status and watermarks are visible.
- API rejects missing/invalid local capture token.

### Phase 2: Local Capture Spool

1. Convert local Beeper job into source capture only.
2. Write every export batch to a local spool before network push.
3. Push undelivered batches to Railway.
4. Mark a batch delivered only after Railway confirms persistence.

Acceptance:

- Local can restart without losing unpushed batches.
- Local can run with Railway offline and later drain the spool.
- Local no longer sends classifications, embeddings, articles, or Atlas artifacts.

### Phase 3: Railway Embeddings

1. Add Railway embedding worker/job.
2. Embed missing/changed `raw_events` using `vibez.embedding_fast`.
3. Store vectors with route/model/dimensions/text hash.
4. Add a retrieval eval comparing:
   - Perplexity 0.6B
   - Qwen3 embedding 8B
   - OpenAI text-embedding-3-small

Acceptance:

- New messages are embedded on Railway without local Ollama.
- Deep-dive vector search can query pgvector.
- Eval report recommends whether Perplexity 0.6B remains default.

### Phase 4: Railway Classification

1. Move inline/backfill classification to Railway.
2. Use `vibez.classification_fast` for batch classification.
3. Use `vibez.classification_quality` only for failed schema repair, uncertain eval samples, or high-value nightly synthesis inputs.
4. Store classifications as model artifacts with route and prompt version.

Acceptance:

- Local no longer runs `classification.inline` or `classification.backfill`.
- Invalid model JSON fails visibly or is repaired by a model route.
- No deterministic semantic fallback labels are introduced.

### Phase 5: Railway Atlas Pipeline

1. Nightly job sequence runs after source ingest:
   - ingest drain health check
   - link/member/stats refresh
   - embeddings
   - classifications
   - Atlas edition generation
   - image generation
   - durable publish
2. Store immutable daily and Sunday editions in Postgres.
3. Cache research dives per edition/article, with explicit respawn.

Acceptance:

- `/atlas` reads the latest Railway edition.
- `/atlas/editions/:date` reads the stored edition for that date.
- Missing editions are explicit, not silently regenerated.
- Research dive repeat loads do not regenerate unless requested.

### Phase 6: Platform-Wide Cleanup

1. Search platform repos for app-local embedding/classification routes.
2. Register each semantic route in the central cognition registry.
3. Replace app-local provider/model/env assumptions with registry adapters.
4. Document any intentional deterministic semantic deviations.

Acceptance:

- No app-local model IDs for embeddings/classification remain except compatibility tests.
- Shared route names and credential aliases are documented.
- Speedrift/model-mediated drift checks cover future route additions.

### Phase 7: Observability And Operations

Add an internal health page/API showing:

- last local Beeper push
- newest raw event
- oldest covered raw event
- unpushed local batches
- Railway ingest failures
- unembedded event count
- unclassified event count
- latest Atlas edition
- missing expected daily/Sunday editions
- current model route IDs for writer, embedding, classifier, image generation

Acceptance:

- A human can tell whether the 4:30am run completed.
- Railway crash emails can be correlated with job stage, not guessed from site uptime.

## Migration Order

1. Registry and resolver first.
2. Railway ingest API and canonical raw tables.
3. Local spool push.
4. Historical backfill from local Beeper source.
5. Railway embeddings.
6. Railway classification.
7. Railway Atlas publish.
8. Disable local processing and artifact writes.
9. Platform-wide embedding/classification cleanup.
10. Observability hardening.

## Risks

- Beeper source stability: mitigate with local spool, watermarks, and batch replay.
- Duplicate history: mitigate with stable `source_event_key` and body hash audit.
- Embedding quality: mitigate with retrieval eval before deleting fallback routes.
- Railway resource limits: keep model work job-based and idempotent; avoid long request-bound work.
- Model route drift: central registry is mandatory; app-local route files are transitional only.

## Quality Gates

- Unit tests for ingest idempotency, route resolution, embedding call shape, classification schema validation.
- Integration test with repeated Beeper batch replay.
- Railway dry-run job against a small fixture window.
- Retrieval eval report for embedding candidates.
- Classification eval report for Mistral Nemo vs Qwen quality route.
- Playwright smoke for Atlas, editions, links, stats, groups, article, research dive.
- Speedrift `coredrift`, `datadrift`, `archdrift`, and `uxdrift` checks on the relevant tasks.
