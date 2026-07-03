# Vibez Atlas Newspaper Spec

## Decision

Turn Atlas from a dashboard-first report into a daily newspaper. The first screen
is a daily issue front page with multiple article cards. One story may lead the
page, but the report must not collapse the day into one theme.

## Product Shape

The daily issue page lives at `/atlas`. It shows a newspaper-style masthead,
issue metadata, a lead article, secondary articles, briefs, and below-the-fold
analytical tools. The old matrix, evidence, stats, and links remain available,
but they support the reporting instead of replacing it.

Each article opens a real route, not a modal. Article routes use stable slugs,
for example `/atlas/issues/2026-05-16/context-management`. Article pages contain
the full narrative, evidence, citations, source links, related channels, and
actions.

Each article page includes a `Spawn deeper dive` action. The action runs real
semantic/vector retrieval over messages and links, then sends the retrieved
evidence to a model-owned adversarial analysis pass. The output is a durable
investigation payload attached to that article response. It should challenge the
article, identify counterevidence, name uncertainties, and produce a practical
next-step synthesis.

## Editorial Contract

The model owns editorial judgment. Code owns evidence assembly, schema
validation, routing, rendering, and job state. Code may mechanically include
top channels, topics, citations, concerns, links, and recent activity. Code must
not decide which theme is "important" through hidden semantic heuristics beyond
explicit mechanical ordering.

The model returns:

- `issue`: date, title, subtitle, edition label, generated time.
- `articles`: 3-6 article summaries, including one `lead` article and multiple
  first-class secondary articles.
- `briefs`: 3-6 short minor but interesting items.
- `crosscurrents`: 2-5 notes about how channels relate, converge, or diverge.
- `article body`: 5 or more paragraphs, actions, evidence refs, links, and
  channel context for each article.

## UI Contract

The front page should look like a readable newspaper, not a compact dashboard:

- masthead and issue metadata at the top;
- lead story centered with image;
- side stories visible above the fold;
- article cards with `Read full article` links;
- briefs and crosscurrents below the top grid;
- diagnostics below the fold: matrix, evidence, stats, and links.

Article pages use a two-column layout:

- main column: headline, dek, image, body, actions, related stories;
- right rail: `Spawn deeper dive`, evidence, citations, links, channels.

Images may be generated placeholders in the first pass. The schema should allow
future image provenance from chat attachments, link thumbnails, or Gemini-created
editorial images.

## Deeper Dive Contract

`Spawn deeper dive` starts from article text and selected evidence refs. The API
retrieves semantically related messages and links, then asks a model to produce
an adversarial deeper dive with:

- claim being tested;
- supporting evidence;
- counterevidence;
- weak spots and missing context;
- alternative interpretations;
- recommended next actions;
- citation refs to retrieved messages and links.

If vector retrieval is unavailable, the API may use the existing keyword fallback
through `searchMessages` and `searchLinks`, but the response must disclose that
retrieval was not semantic.

## Acceptance Criteria

- `/api/atlas?hours=48` returns an `editorial_report.issue` and multiple
  `editorial_report.articles`.
- `/atlas` renders a newspaper-style issue page with at least three article
  cards above the fold.
- Article cards link to real article routes.
- `/atlas/issues/[date]/[slug]` renders the full article with evidence, links,
  channels, actions, and a deeper-dive button.
- `/api/atlas/deeper-dive` runs retrieval and model synthesis for an article.
- Unit tests cover issue normalization, article route lookup, and deeper-dive
  retrieval/model orchestration.
- Dashboard unit tests, lint, build, Speedrift check, local smoke, Railway
  deploy, and remote smoke pass before handoff.
