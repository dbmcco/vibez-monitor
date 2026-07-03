# Vibez Atlas Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a testable `/atlas` UI that maps the latest 48 hours across channels, topics, time, citations, and supporting links.

**Architecture:** Add a pure Atlas view-model module, a thin DB/API layer, and a standalone client page. Keep semantic interpretation model-owned for future work by emitting evidence refs and diagnostics rather than accepted durable narratives.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Postgres via existing `pg` pool, Vitest, existing Tailwind/global CSS classes.

---

### Task 1: Atlas View Model

**Files:**
- Create: `dashboard/src/lib/atlas.ts`
- Create: `dashboard/src/lib/atlas.test.ts`

- [ ] Write failing tests for grouping rows by channel and topic.
- [ ] Write failing tests for selecting stable message citation refs.
- [ ] Implement `buildAtlasSnapshotFromRows(input)`.
- [ ] Run `npm run test:unit -- src/lib/atlas.test.ts`.
- [ ] Commit as `feat: add atlas snapshot view model`.

### Task 2: Atlas Data Access And API

**Files:**
- Modify: `dashboard/src/lib/db.ts`
- Create: `dashboard/src/app/api/atlas/route.ts`

- [ ] Add `getAtlasSnapshot({ windowHours })` to `db.ts`.
- [ ] Query recent messages with classifications and recent links.
- [ ] Pass rows into `buildAtlasSnapshotFromRows`.
- [ ] Add `/api/atlas` with bounded `hours` parsing.
- [ ] Run Atlas unit tests.
- [ ] Commit as `feat: expose atlas dashboard api`.

### Task 3: Atlas UI And Navigation

**Files:**
- Create: `dashboard/src/app/atlas/page.tsx`
- Modify: `dashboard/src/components/Nav.tsx`
- Modify: `dashboard/src/app/page.tsx`

- [ ] Add Atlas nav item before Briefing.
- [ ] Redirect `/` to `/atlas`.
- [ ] Render overview metrics, matrix, lens buttons, detail rail, and evidence drawer.
- [ ] Link related topics to `/stats` and related resources to `/links`.
- [ ] Run dashboard lint and targeted tests.
- [ ] Commit as `feat: render atlas report surface`.

### Task 4: Verification And UX Readiness

**Files:**
- Modify only files needed for compile, lint, or usability fixes.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `./.workgraph/drifts check --task atlas-report-redesign --write-log --create-followups`.
- [ ] Start local dashboard dev server on an available port.
- [ ] Commit verification fixes if any.

## Quality Notes

No backend ingestion or schema migration is in scope. No State System runtime call
is in scope. The first pass must make the UI testable and preserve evidence refs
for later durable interpretation.
