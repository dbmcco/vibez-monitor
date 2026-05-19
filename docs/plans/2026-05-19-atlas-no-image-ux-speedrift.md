# Atlas No-Image UX Speedrift Plan

Date: 2026-05-19
Branch: `vibez-atlas-redesign`
Task: `atlas-no-image-ux-playwright-gates`

## Goal

Make the Railway Atlas newspaper viewable and testable while real article images are unavailable. The page must not use fake generated images, broken image URLs, or obsolete evidence-desk fallback UI. The reader should still be able to read the front page, open full articles, open research dives, and browse saved editions.

## Scope

- Keep the AtlasCloud route in place but do not require `VIBEZ_ATLASCLOUD_API_KEY` for viewing existing editions.
- Replace fake SVG editorial image fallbacks with an explicit no-photo treatment.
- Support `images=off` for deterministic no-image review while provider credentials are pending.
- Add a Playwright UX gate that can validate the no-images state.
- Run desktop and mobile browser checks against Railway before handing the site back.

## Out Of Scope

- Generating real images before the AtlasCloud token exists.
- Recovering the May 17 edition.
- Repairing stats/member-count history.
- Redesigning Links, Stats, or Groups.
- Merging the branch.

## Speedrift Gates

1. `coredrift`: task contract stays within no-image viewing and browser gates.
2. `specdrift`: this plan remains the drift anchor for the bounded pass.
3. `uxdrift`: front page, article, archive, and research-dive routes are browser-tested at desktop, wide, and mobile sizes.
4. `fixdrift`: no raw markup, broken links, horizontal overflow, obsolete Evidence Desk, or fake SVG image fallbacks.
5. `verification`: unit tests, build, lint, Playwright UX script, Railway health, and git push all complete before handoff.

## Browser Acceptance

- `/atlas?hours=48&images=off` renders the newspaper without real article media.
- The edition selector and `/atlas/editions` are reachable.
- At least five `Read full article` links are present.
- A clicked full article renders body text, citations, and `Spawn deeper dive`.
- The research-dive page opens from the article route.
- No element exceeds viewport width on `390x900`, `1440x1100`, or `1728x1100`.
- No visible raw HTML/markdown artifacts appear in reader text.
- No `data:image/svg+xml` editorial fallback images are rendered.
- In no-images mode, the page renders deliberate `data-atlas-photo-status` blocks instead of broken media.

## Deployment Acceptance

- Branch is committed and pushed.
- Railway deployment succeeds.
- `https://dashboard-production-8686.up.railway.app/api/health` returns `200`.
- The no-images Playwright gate passes against Railway after access authentication.
