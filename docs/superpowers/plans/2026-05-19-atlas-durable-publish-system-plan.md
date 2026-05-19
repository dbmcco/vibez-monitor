# Atlas Durable Publish System Speedrift Plan

> **Execution mode:** Speedrift / Workgraph. Treat this as the drift anchor for
> implementation. Run drift checks before edits and before task completion.

## Root Task

`atlas-durable-publish-system`: make Atlas a resilient daily newspaper publisher
with durable images, meaningful channel reports, and Playwright-verified layout.

Required drift lanes:

- `coredrift`: scope, contracts, acceptance.
- `specdrift`: conformance to this spec and prior newspaper spec.
- `archdrift`: stage boundaries, persistence, idempotency, no brittle chain.
- `datadrift`: Postgres schema and edition/asset state.
- `uxdrift`: newspaper layout, below-fold meaning, overflow, mobile.
- `yagnidrift`: avoid rebuilding all of Atlas or adding unnecessary queues.

## Task Graph

### 1. Publish Job State And Schema

**Goal:** Add the durable state needed to make nightly publishing observable and
resumable.

**Files likely touched:**

- `dashboard/src/lib/atlas-artifact.ts`
- `dashboard/src/lib/admin-enrichment.ts`
- `dashboard/src/lib/push-ingest.ts`
- tests under `dashboard/src/lib/*test.ts`

**Acceptance:**

- Postgres schema creates `atlas_publish_jobs` and `atlas_assets`.
- Publish job rows record stage status, retry count, timestamps, and errors.
- Existing `atlas_editions` publication still works.
- Unit tests cover schema creation and job status transitions.

### 2. Durable Article Images

**Goal:** Generate and serve real article images from the article context.

**Files likely touched:**

- `dashboard/src/lib/atlas-assets.ts`
- `dashboard/src/lib/atlas-image-generation.ts`
- `dashboard/src/app/api/atlas/image/[...path]/route.ts`
- `dashboard/src/lib/atlas-artifact.ts`
- central model/credential registry if a new app route is needed

**Acceptance:**

- Each article gets an image asset job from title, dek, body, section, citations,
  and the model-written image prompt.
- Generated image URLs are stored durably and attached to the article payload.
- Image failure records status and error without blocking article publication.
- Image route serves durable assets before local generated files.
- Tests cover ready, pending, and failed image states.

### 3. Front Page Newspaper Grid

**Goal:** Make the intended newspaper layout real at common viewports.

**Files likely touched:**

- `dashboard/src/app/atlas/AtlasClient.tsx`
- `dashboard/src/lib/atlas-ui.ts`
- related UI tests

**Acceptance:**

- 1440px viewport shows two secondary stories on the left, lead story centered,
  and two secondary stories on the right when at least five articles exist.
- 390px mobile shows lead first, then secondary stories with no overlap.
- Article image slots render generated images or explicit status states.
- No front-page horizontal overflow.

### 4. Model-Written Channel Reports

**Goal:** Replace deterministic room filler with useful reporting by channel.

**Files likely touched:**

- `dashboard/src/lib/atlas-channel-report.ts`
- `dashboard/src/lib/atlas-report.ts`
- `dashboard/src/app/atlas/AtlasClient.tsx`
- `config/model-routing.json` only if a route is not already represented

**Acceptance:**

- Channel reports are model-written from channel evidence.
- Each report answers: what happened, why it matters, what to watch/action, and
  which citations support it.
- No visible raw message IDs in cards.
- Long channel names, refs, and labels wrap without card bleed.
- Tests verify prompt ownership and schema normalization.

### 5. Below-Fold Reader Value

**Goal:** Make below-fold sections explain value before diagnostics.

**Files likely touched:**

- `dashboard/src/app/atlas/AtlasClient.tsx`
- `dashboard/src/lib/atlas-report.ts`
- UI tests or Playwright scripts

**Acceptance:**

- Default below-fold view shows reader-value sections: Signals Worth Acting On,
  Unresolved Questions, Evidence Desk, and Useful Links.
- Diagnostics remains available but is not the default reading path.
- Sections avoid repeated raw evidence inventory.
- Copy answers what changed, why care, and what to do.

### 6. Nightly Orchestration Hardening

**Goal:** Make the 4:30 ET job robust and auditable.

**Files likely touched:**

- `dashboard/scripts/run-railway-enrichment.mjs`
- local launchd job scripts/config
- `dashboard/src/lib/admin-enrichment.ts`
- docs/runbook if present

**Acceptance:**

- Ingest, enrichment, article generation, image generation, and publish stages
  can be rerun independently.
- The job exits non-zero only when the configured critical stage fails.
- Job output includes the publish job id, stage summary, edition date, and
  generated artifact timestamp.
- Railway crash noise is separated from active deployment health in the runbook.

### 7. Playwright And Drift Verification

**Goal:** Prevent regressions in the page the user actually reads.

**Files likely touched:**

- `dashboard/scripts/check-atlas-ux.mjs` or equivalent
- docs/runbook or package script if adopted

**Acceptance:**

- Playwright captures/evaluates 1440px, 1728px, and 390px.
- Checks assert no horizontal overflow, no text bleed in channel cards, expected
  story count, and image status visibility.
- `npm run test:unit`, `npm run build`, and Speedrift drift checks pass.
- Railway deploy succeeds and remote `/atlas` smoke matches the fresh edition.

## Implementation Order

1. Schema/job state.
2. Durable image assets.
3. Article/front-page layout.
4. Channel reports.
5. Below-fold redesign.
6. Nightly orchestration.
7. Playwright and deployment verification.

This order builds the durable foundation before UI polish and avoids another
round of patching symptoms into the fragile nightly chain.
