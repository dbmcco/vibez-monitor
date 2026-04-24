# Semantic Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fake semantic vectors with real routed embeddings for messages and links, keep document indexing local, and make Railway perform query-time embedding against the same embedding space.

**Architecture:** Add a shared embedding route to the existing model router, use that route from both backend and dashboard, and keep the current `VIBEZ_PGVECTOR_DIM` contract by shortening OpenAI embeddings to the configured dimension. Local sync/indexing will upsert real message and link vectors into pgvector, while local and Railway dashboard queries will embed search text at request time using the same routed model.

**Tech Stack:** Python backend, Next.js dashboard, OpenAI embeddings API, Postgres pgvector, SQLite source-of-truth, Workgraph/Speedrift.

---

### Task 1: Shared Embedding Routing

**Files:**
- Modify: `config/model-routing.json`
- Modify: `backend/vibez/model_router.py`
- Modify: `dashboard/src/lib/model-router.ts`
- Test: `backend/tests/test_model_router.py`
- Test: `dashboard/src/lib/model-router.test.ts`

- [ ] Add an `embedding.semantic` route to the shared manifest.
- [ ] Extend backend and dashboard model routers to support embedding calls and optional dimensions.
- [ ] Write/adjust tests first so embedding routes fail before the implementation exists.
- [ ] Implement the minimal router changes to make those tests pass.
- [ ] Commit the routing foundation checkpoint.

### Task 2: Real Message Embeddings

**Files:**
- Modify: `backend/vibez/semantic_index.py`
- Modify: `backend/scripts/pgvector_index.py`
- Modify: `backend/scripts/run_sync.py`
- Modify: `backend/scripts/run_sync_once.py`
- Modify: `dashboard/src/lib/semantic.ts`
- Test: `backend/tests/test_semantic_index.py`
- Test: `backend/tests/test_pgvector_e2e.py`

- [ ] Replace the deterministic hash embedding path with routed provider-backed embeddings in the backend indexer.
- [ ] Update dashboard message retrieval to embed queries through the shared router instead of local hash vectors.
- [ ] Keep the existing configured pgvector dimension by passing `VIBEZ_PGVECTOR_DIM` into the embedding request.
- [ ] Add or update focused tests that prove real embedding helpers are used and SQL payloads still match the current table contract.
- [ ] Commit the message retrieval checkpoint.

### Task 3: Link Embedding Index + Hybrid Search

**Files:**
- Modify: `backend/vibez/semantic_index.py`
- Modify: `backend/scripts/pgvector_index.py`
- Modify: `dashboard/src/lib/semantic.ts`
- Modify: `dashboard/src/lib/db.ts`
- Modify: `dashboard/src/app/api/links/route.ts`
- Test: `backend/tests/test_links_search.py`
- Test: `dashboard/src/lib/link-search.test.ts`

- [ ] Add a pgvector schema/indexer for links using existing SQLite `links` rows.
- [ ] Implement a hybrid link search path that combines semantic score, lexical rank, and existing value score ordering.
- [ ] Keep the current FTS path as the fallback when pgvector is unavailable.
- [ ] Write failing tests that prove semantic link search is used when configured and lexical fallback still works.
- [ ] Commit the link retrieval checkpoint.

### Task 4: Local-to-Railway Embedding Rollout

**Files:**
- Modify: `scripts/local_sync_to_railway.sh`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] Add the minimal env/script support needed to mirror embeddings from the local machine to Railway pgvector.
- [ ] Document the required env vars for local indexing and Railway query-time retrieval.
- [ ] Keep Railway free of background indexing jobs.
- [ ] Commit the rollout checkpoint.

### Task 5: Verification and Ship

**Files:**
- Modify: `.workgraph/graph.jsonl` (task state only)

- [ ] Run scoped backend tests.
- [ ] Run scoped dashboard unit tests.
- [ ] Run the dashboard build.
- [ ] Backfill/index embeddings locally, then verify local semantic search.
- [ ] Push the code and deploy to Railway.
- [ ] Backfill/index embeddings for Railway, then verify Railway semantic message and link search.
- [ ] Run the closing drift check and mark the Workgraph task done.
