# Vibez Atlas Redesign Spec

## Decision

Build a new `Atlas` surface as the default Vibez entry point. The Atlas answers
what moved in the last 48 hours across channels, topics, and time. It preserves
the existing `Stats` and `Links` pages as supporting analytical tools and keeps
`Briefing` available as the older daily-report narrative view.

## Design Sessions Compared

The UX session recommended a standalone `/atlas` page with a Latest 48h Report,
Channel x Topic Matrix, lens controls, a narrative rail, and an evidence drawer.
This was the strongest product fit because it directly addresses the failure of
single-thread briefing narratives in a multi-channel environment.

The model-mediated architecture session recommended a Vibez-local first pass
with State-System-compatible refs and schemas, but no hard State System runtime
dependency yet. This preserves the right boundary: Vibez owns raw messages,
links, retrieval, and rendering; model/state layers later own promoted durable
interpretations.

The incremental implementation session recommended reusing current Postgres
data and dashboard primitives, avoiding Catchup as the first path, and adding a
small Atlas data model, API route, and UI. This gives the fastest testable UI
without rewriting synthesis, Stats, Links, or backend ingestion.

## Selected Shape

The first Atlas version is a local, deterministic projection over existing data.
It does not claim to be the durable State System truth. It creates evidence refs
such as `vibez:message:<id>` and `vibez:link:<id-or-url>` so later State System
promotion can reuse the same provenance.

The page contains:

- Latest 48h overview: messages, people, channels, topics, and links.
- Channel x Topic matrix: rows are active channels, columns are active topics,
  cells show activity count and high-signal citation coverage.
- Lenses: all, rising topics, concerns, links, and under-covered diagnostics.
- Detail rail: selected channel-topic intersection with citations and related
  links.
- Evidence drawer: opens a durable citation record with sender, channel,
  timestamp, body/title, topics, and source refs.

## Model-Mediated Boundary

Code may assemble candidate evidence, counts, refs, and matrix cells. Code must
not invent qualitative narratives such as "this matters because..." as durable
truth. In this first pass, labels such as "concerns" are diagnostics based on
existing flags and question-like messages, not accepted semantic state.

Later, a model-owned `AdaptiveReportSurfacePlan` can interpret the Atlas evidence
and propose narrative sections, claims, uncertainty, omissions, and state
candidates. Those proposals should remain schema-validated and evidence-backed.

## First-Pass Acceptance Criteria

- `/` redirects to `/atlas`.
- Top nav includes `Atlas` before `Briefing`.
- `/api/atlas?hours=48` returns a typed Atlas snapshot.
- `/atlas` renders a useful UI without requiring a model call.
- Message and link citations are clickable inside the UI through an evidence
  drawer or external link.
- Stats and Links remain unchanged and linked from Atlas.
- Unit tests cover Atlas grouping, citation selection, and API-safe window
  handling.
- Quality gates pass: dashboard unit tests, lint, build, and Speedrift drift
  check for `atlas-report-redesign`.
