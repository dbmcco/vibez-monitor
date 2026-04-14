# Local Analysis + Railway Serving — Design Document

## Goal

Move all background analysis and inference off Railway and onto the always-on local machine, while keeping Railway as a read-serving replica plus an optional interactive chat surface.

## Scope

This design covers:
- local-only background processing for sync-derived analysis
- replication of derived data from local SQLite to Railway
- removal of Railway background inference loops
- preservation of Railway as a dashboard/API host

This design does not cover:
- a full LLM provider migration from Anthropic to OpenAI
- replacing the interactive chat endpoint yet
- changing the room allowlist that is already live

## Desired End State

The local machine is the single background worker and source of truth for both raw chat data and derived analysis. Railway does not run any periodic or looped inference jobs. Railway serves the latest pushed state for messages, links, wisdom, summaries, and related APIs. The only model-capable feature left on Railway is explicit user-triggered chat.

## Architecture

### Local Machine

The local machine continues to ingest Beeper and Google Groups data into the main SQLite database. It also becomes the only place that runs:
- message classification
- link extraction refresh
- link author enrichment
- wisdom extraction
- synthesis / daily report generation
- any catch-up or backlog repair jobs

These jobs can continue to use the existing local Python scripts and launch agents, but they must no longer rely on Railway to compute the final analysis state.

### Railway

Railway becomes a serving replica with no background model work. It stores the pushed SQLite-derived state and serves:
- `/api/messages`
- `/api/stats`
- `/api/links`
- `/api/wisdom`
- `/api/briefing`
- `/api/spaces`
- `/api/chat` for explicit interactive usage

Railway must not run:
- sync loops that call wisdom
- sync loops that call link authorship enrichment
- sync loops that call synthesis
- background classifier backfills

## Data Flow

### 1. Local ingest

Local sync jobs pull new messages from Beeper and Google Groups into the local SQLite database.

### 2. Local analysis

After ingest, local jobs refresh all derived state that the dashboard depends on:
- `classifications`
- `links`
- `wisdom_topics`
- `wisdom_items`
- `wisdom_recommendations`
- `daily_reports`
- any related `sync_state` watermarks needed by those jobs

### 3. Push to Railway

The local push pipeline uploads both raw and derived tables to Railway. Railway should receive already-computed rows rather than recomputing them.

### 4. Railway serving

The dashboard APIs read directly from the replicated Railway SQLite state. Freshness depends on the last successful local analysis-and-push cycle.

## Tables And State To Replicate

The push path must treat these as first-class replicated artifacts:
- `messages`
- `classifications`
- `links`
- `daily_reports`
- `wisdom_topics`
- `wisdom_items`
- `wisdom_recommendations`
- relevant `sync_state` keys for pushed analysis state

The push should preserve the active allowlist behavior already in place so Railway only reflects the approved AGI rooms plus `made-of-meat`.

## Operational Changes

### Railway startup

`scripts/railway-start.sh` should stop running analysis jobs in the background loop. At most, Railway may run:
- application startup
- health-serving processes
- non-LLM maintenance that is strictly required for serving

The target posture is zero background inference.

### Local push script

`scripts/local_sync_to_railway.sh` becomes responsible for ensuring derived data is up to date locally before push, and for pushing those derived tables to Railway.

The existing concept of "remote refresh" should be removed or reduced to non-inference serving maintenance only. Railway should not be asked to recompute wisdom, links, or synthesis after a push.

### Launch agents / schedulers

The local machine should remain responsible for cadence. If the machine is always on, this is the correct place to schedule:
- frequent push-only replication
- periodic local wisdom runs
- periodic local synthesis runs
- local link-author enrichment drain jobs

## Failure Model

### Local analysis fails

If a local analysis job fails, Railway continues serving the last successful pushed state. No remote recomputation is attempted.

### Push fails

If replication fails, Railway remains stale but available. The next local push retries and advances the state.

### Railway restarts

A Railway restart must not trigger model work. The service should simply come back up and serve the previously replicated data mounted on `/data`.

## Error Handling

### Local job retries

Retries should happen locally, where the source database and write ownership already live. This avoids long-running write contention on Railway.

### Partial refreshes

Derived-table updates should remain incremental where possible, using existing watermarks, but full rebuilds must remain available locally for repair.

### SQLite contention

Long-running local analysis jobs may still need bounded retry or serialization locally, but the system should no longer depend on a remote SQLite database surviving background inference under live traffic.

## Testing Strategy

### Backend

Add or update tests for:
- local push of derived tables
- Railway startup behavior with no background inference
- links and wisdom APIs reading pushed data without needing recomputation
- push script behavior when `remote refresh` is removed or disabled

### Integration

Verify this flow end-to-end:
1. insert new local messages
2. run local analysis
3. push to Railway
4. confirm Railway APIs reflect the derived rows without running any remote jobs

### Operational verification

Live checks should confirm:
- Railway deploy has no running background wisdom/link/synthesis jobs
- Railway variables do not imply active remote inference loops
- local jobs can advance wisdom and links and then push those results successfully

## Rollout Plan

1. Stop Railway background inference.
2. Ensure local jobs can refresh all required derived tables.
3. Extend push logic to replicate those derived tables.
4. Run a one-time local full refresh for links and wisdom if needed.
5. Push the refreshed state to Railway.
6. Verify that Railway serves the new data without doing any background model work.

## Open Follow-Ups

- Replace remaining Anthropic-backed interactive chat with a cheaper OpenAI model.
- Decide whether local background analysis should also migrate to OpenAI or another cheaper provider.
- Decide how much freshness telemetry the dashboard should expose so stale local pipelines are obvious.
