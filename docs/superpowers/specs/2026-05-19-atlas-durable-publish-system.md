# Atlas Durable Publish System Spec

## Problem

Atlas is now useful enough to become the main newspaper surface, but the current
publish path is brittle. A single nightly chain tries to ingest data, enrich
records, write articles, create a durable edition, and serve the result. When
one late stage fails, the site silently keeps serving an old edition. Images are
the clearest symptom: article records contain image briefs, but no publish stage
turns those briefs into durable assets.

The front page also does not hold the intended newspaper structure. At common
laptop widths the lead and secondary stories collapse into one vertical stack,
the side lanes contain only one article each, and below-the-fold sections expose
raw diagnostic material without enough reader-facing interpretation.

## Product Decision

Implement Atlas as a resumable edition publisher. Each edition is a durable
object with explicit stage state, article payloads, image assets, channel briefs,
and publication metadata. Article writing, image generation, channel reporting,
and diagnostics remain separate stages so one failure can be retried without
regenerating everything or blocking the whole newspaper.

## Model-Mediated Contract

The model owns editorial judgment: story selection, article framing, image
briefs, channel interpretation, open questions, and reader value. Code owns
evidence assembly, stage orchestration, schema validation, persistence, rendering,
status reporting, retries, and mechanical layout.

Code must not invent story content when a model call fails. It may publish a
partial edition only when the partial state is explicit, for example `images:
pending`, `embeddings: pending`, or `channel_briefs: failed`. It must keep the
last successful edition visible while recording the failed edition job.

## Durable Objects

Add or evolve the following Postgres-backed records:

- `atlas_publish_jobs`: one row per edition date and edition type, with stage
  statuses, timestamps, retry counts, error summaries, and source window.
- `atlas_editions`: the published newspaper payload, already present, updated
  atomically after article validation.
- `atlas_assets`: one row per article image or generated edition asset, with
  edition date, article slug, prompt, content type, storage location or bytes,
  status, provider metadata, and error state.
- `atlas_channel_reports`: model-written channel briefs for the edition,
  keyed by edition date, channel, and window hours.

The local `.generated` files may remain a developer convenience, but they are
not the durable source of truth.

## Publish Stages

1. `ingest`: local Beeper sync and Railway push complete.
2. `enrich`: classification and embeddings run idempotently. Failure marks
   enrichment pending or failed but does not corrupt the edition.
3. `write_articles`: build the issue shell and article pages from evidence.
   Failure blocks new edition publication because fake narrative is not allowed.
4. `write_channel_reports`: generate useful channel summaries from evidence.
   Failure keeps prior/pending channel reports out of the reader path.
5. `generate_images`: create one image per article from article context and
   image prompt. Failure marks image status and leaves article text published.
6. `publish`: write the edition payload and indexes atomically.
7. `verify`: run API, page, image route, and Playwright checks.

## Front Page Contract

At desktop and laptop widths, the newspaper front page shows:

- left lane: two secondary stories;
- center lane: one lead story;
- right lane: two secondary stories;
- mobile: lead first, then secondary stories in a clean stack.

The breakpoint must work at ordinary laptop widths, not only very wide
viewports. Article image slots render real generated images when ready and an
explicit pending/failed state otherwise.

## Below-Fold Contract

Below the fold defaults to reader value, not diagnostics.

Primary sections:

- `Report by Channel`: model-written channel briefs that explain what happened
  in each active channel, why it matters, open questions, and citations.
- `Signals Worth Acting On`: actions and watch points across the edition.
- `Unresolved Questions`: questions the community may need to answer.
- `Evidence Desk`: clickable citations and durable links.

Diagnostics remain available behind the diagnostics tab. Raw message IDs must
not bleed outside cards; citation display should use readable labels and
clickable refs.

## Acceptance Criteria

- Nightly update records a publish job with per-stage status and errors.
- A model or image failure is visible in job state and does not silently serve a
  stale edition as if it were fresh.
- Atlas front page renders one lead plus up to four secondary stories at a
  1440px viewport.
- Article images are generated from article context and served from durable
  asset records or explicit pending/failed state.
- `/api/atlas/image/...` can serve durable generated assets without relying on
  local `.generated` files.
- `Report by Channel` contains meaningful model-written channel analysis, not
  deterministic filler.
- Channel and topic cards do not overflow at 1440px desktop or 390px mobile.
- Playwright checks cover 1440px, 1728px, and 390px viewports.
- Unit tests, build, and Speedrift drift checks pass before deploy.
