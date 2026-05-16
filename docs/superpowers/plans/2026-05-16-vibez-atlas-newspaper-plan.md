# Vibez Atlas Newspaper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Atlas as a daily newspaper front page with durable article routes and a model-mediated deeper-dive action.

**Architecture:** Keep raw Atlas data in `atlas.ts`, move newspaper editorial structure into `atlas-report.ts`, add a focused deeper-dive module, and render issue/article pages from the API response. Code assembles evidence and validates schemas; models own editorial interpretation and adversarial synthesis.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, existing model router, existing pgvector/semantic search helpers, Railway deployment.

---

## File Structure

- Modify `dashboard/src/lib/atlas-report.ts`: extend editorial schema from single main topic to issue/articles/briefs/crosscurrents, normalize article slugs, and keep backwards-compatible report sections.
- Modify `dashboard/src/lib/atlas-report.test.ts`: add failing tests for multi-article issue normalization and prompt instructions.
- Create `dashboard/src/lib/atlas-deeper-dive.ts`: retrieve article-related messages and links, build adversarial prompt, normalize deeper-dive output.
- Create `dashboard/src/lib/atlas-deeper-dive.test.ts`: verify retrieval and model orchestration without network calls.
- Modify `dashboard/src/app/api/atlas/route.ts`: return the newspaper issue schema through existing API.
- Create `dashboard/src/app/api/atlas/deeper-dive/route.ts`: POST endpoint for article deeper dives.
- Modify `dashboard/src/app/atlas/page.tsx`: render newspaper front page and keep matrix/evidence/stats below the fold.
- Create `dashboard/src/app/atlas/issues/[date]/[slug]/page.tsx`: render full article pages from the API report.
- Modify `config/model-routing.json`: add a `dashboard.atlas_deeper_dive` route.
- Modify `.gitignore`: ignore `.superpowers/` visual companion artifacts.
- Add docs/spec and docs/plan files.

## Tasks

### Task 1: Newspaper Issue Schema

**Files:**
- Modify: `dashboard/src/lib/atlas-report.ts`
- Modify: `dashboard/src/lib/atlas-report.test.ts`

- [ ] **Step 1: Write failing issue normalization test**

Add a test asserting that `normalizeAtlasEditorialReport` accepts multiple articles, gives each one a slug, preserves lead/secondary roles, and filters unsupported citation refs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- atlas-report.test.ts`

Expected: fail because `articles` and issue normalization are not implemented.

- [ ] **Step 3: Implement issue/article types and normalization**

Add `AtlasEditorialIssue`, `AtlasEditorialArticle`, `AtlasEditorialBrief`, and `AtlasEditorialCrosscurrent`. Normalize 3-6 articles, one lead if supplied, stable slugs, image fields, article body, actions, evidence refs, link refs, channels, and related article slugs.

- [ ] **Step 4: Update prompt schema**

Change `buildAtlasReportMessages` so it asks for a daily newspaper issue and explicitly says not to reduce the day to one theme unless evidence truly supports that.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- atlas-report.test.ts`

Expected: pass.

### Task 2: Deeper Dive Module

**Files:**
- Create: `dashboard/src/lib/atlas-deeper-dive.ts`
- Create: `dashboard/src/lib/atlas-deeper-dive.test.ts`
- Modify: `config/model-routing.json`

- [ ] **Step 1: Write failing deeper-dive orchestration test**

Mock retrieval and model generation. Assert `generateAtlasDeeperDive` calls message and link retrieval with the article query, then calls `dashboard.atlas_deeper_dive`, and returns supporting evidence, counterevidence, weak spots, interpretations, and actions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- atlas-deeper-dive.test.ts`

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement retrieval and prompt builder**

Use existing `searchMessages` and `searchLinks` wrappers for real retrieval. They use pgvector when configured and keyword fallback otherwise. Return a `retrieval_mode` value so the UI can disclose fallback.

- [ ] **Step 4: Add model route**

Add `dashboard.atlas_deeper_dive` in `config/model-routing.json` using OpenRouter JSON mode.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- atlas-deeper-dive.test.ts`

Expected: pass.

### Task 3: API Routes

**Files:**
- Modify: `dashboard/src/app/api/atlas/route.ts`
- Create: `dashboard/src/app/api/atlas/deeper-dive/route.ts`
- Modify: `dashboard/src/app/api/atlas/route.test.ts`

- [ ] **Step 1: Extend API tests**

Assert `/api/atlas` includes `editorial_report.issue` and `articles`. Add deeper-dive route tests for valid POST and malformed body.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test:unit -- route.test.ts atlas-deeper-dive.test.ts`

Expected: fail on missing deeper-dive route and old API expectations.

- [ ] **Step 3: Implement route changes**

Keep `/api/atlas` response shape stable but include the expanded report. Add `POST /api/atlas/deeper-dive` accepting `{ article, hours }` and returning `{ deeper_dive, error }`.

- [ ] **Step 4: Run focused tests**

Run: `npm run test:unit -- route.test.ts atlas-deeper-dive.test.ts`

Expected: pass.

### Task 4: Newspaper UI and Article Pages

**Files:**
- Modify: `dashboard/src/app/atlas/page.tsx`
- Create: `dashboard/src/app/atlas/issues/[date]/[slug]/page.tsx`

- [ ] **Step 1: Render front page**

Replace report-first cards with a newspaper issue: masthead, lead article, side articles, briefs, crosscurrents, and existing diagnostics below the fold.

- [ ] **Step 2: Render article route**

Fetch `/api/atlas?hours=48`, locate the article by date and slug, and render headline, dek, image, body, actions, evidence, links, channels, and related articles.

- [ ] **Step 3: Add deeper-dive button**

The article page posts the selected article to `/api/atlas/deeper-dive` and renders the resulting adversarial analysis on the page.

- [ ] **Step 4: Build check**

Run: `npm run build`

Expected: pass TypeScript and Next build.

### Task 5: Gates, Deploy, and Handoff

**Files:**
- No new implementation files unless gates reveal a scoped bug.

- [ ] **Step 1: Run unit tests**

Run: `npm run test:unit`

Expected: all tests pass.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: no errors. Existing unrelated warnings may remain.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: build passes.

- [ ] **Step 4: Run Speedrift**

Run: `driftdriver --dir "$PWD" --json check --task atlas-report-redesign --lane-strategy all`

Expected: no blocking findings. Any explicit model-failure null behavior is documented as intentional.

- [ ] **Step 5: Commit, deploy, smoke, push**

Commit scoped changes, deploy Railway dashboard from HEAD snapshot, wait for deployment `SUCCESS`, smoke `/api/atlas`, smoke an article route, smoke deeper dive, then `git pull --rebase && git push && git status`.

## Self-Review

Spec coverage: The plan covers newspaper issue, real article routes, evidence/citations/links, and vector-backed adversarial deeper dive.

Placeholder scan: No task relies on an undefined route, file, or behavior.

Type consistency: The planned schema names align with the existing `AtlasEditorialReport` expansion path and the new deeper-dive module.
