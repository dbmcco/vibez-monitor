# Collective Wisdom — Next Steps for Fresh Agent

## Context

We're adding a "Collective Wisdom" feature to vibez-monitor — a knowledge graph extracted from the group's full chat history, with a Wisdom page and persistent chat rail.

**Design doc:** `docs/plans/2026-03-10-collective-wisdom-design.md`
**Implementation plan:** `docs/plans/2026-03-10-collective-wisdom-plan.md` (complete code for all 8 tasks)

## Current State

### What's done
- Design doc approved and committed
- Implementation plan written with full code for all 8 tasks
- Workgraph tasks created with dependency chain
- Links feature fully shipped (2,058 links, room-filtered, correct counts/timestamps)
- Deployed to Railway (latest code pushed)

### Workgraph task graph
```
wisdom-schema → wisdom-extraction ──────→ wisdom-deploy
wisdom-schema → wisdom-api → wisdom-page → wisdom-nav → chat-rail → chat-context → wisdom-deploy
```

`wisdom-schema` is the entry point — no blockers, ready to start.

### Key files to read first
- `docs/plans/2026-03-10-collective-wisdom-plan.md` — full code for every task
- `backend/vibez/db.py` — existing schema + migration pattern
- `backend/vibez/synthesis.py` — existing Anthropic API call pattern
- `dashboard/src/components/Nav.tsx` — nav to modify
- `dashboard/src/app/layout.tsx` — layout to modify for chat rail
- `dashboard/src/app/links/page.tsx` — UI pattern to follow for Wisdom page
- `dashboard/src/app/chat/page.tsx` — existing chat logic (moves to rail)

## How to Execute

### Option A: Manual task-by-task
```bash
cd /Users/braydon/projects/personal/vibez-monitor
wg ready                    # see available tasks
wg claim wisdom-schema      # start the first task
# ... do the work ...
wg done wisdom-schema       # mark complete
wg ready                    # next tasks unlock
```

### Option B: Workgraph service (autonomous agents)
```bash
cd /Users/braydon/projects/personal/vibez-monitor
wg service start            # starts coordinator + dispatches agents
wg status                   # monitor progress
```

### Option C: Subagent-driven (from Claude Code session)
Use `superpowers:executing-plans` skill with the plan at `docs/plans/2026-03-10-collective-wisdom-plan.md`.

## Task Details (quick reference)

| ID | Task | Depends On | Hours | Key Files |
|----|------|-----------|-------|-----------|
| wisdom-schema | Add 3 DB tables | — | 0.5 | backend/vibez/db.py |
| wisdom-extraction | Haiku batch pipeline | schema | 1.5 | backend/vibez/wisdom.py, backend/scripts/run_wisdom.py |
| wisdom-api | Dashboard API endpoints | schema | 1.0 | dashboard/src/lib/db.ts, dashboard/src/app/api/wisdom/route.ts |
| wisdom-page | Wisdom page UI | api | 1.5 | dashboard/src/app/wisdom/page.tsx |
| wisdom-nav | Update nav bar | page | 0.25 | dashboard/src/components/Nav.tsx |
| chat-rail | Persistent chat panel | nav | 1.5 | dashboard/src/components/ChatRail.tsx, layout.tsx, globals.css |
| chat-context | Page context in chat API | rail | 0.25 | dashboard/src/app/api/chat/route.ts |
| wisdom-deploy | E2E verify + Railway deploy | context, extraction | 0.5 | — |

## Critical Notes

- **Database:** `vibez.db` lives at repo root (not in backend/). Dashboard reads via `../vibez.db` relative to dashboard CWD.
- **Excluded rooms:** Defined in `backend/vibez/links.py` EXCLUDED_ROOMS — BBC News, Bloomberg, TechRadar, GoodSense Grocers, Lightforge, Plum, MTB Rides.
- **Railway:** Uses `VIBEZ_PUBLIC_MODE=true` — Contribute page disabled, but Wisdom should be public. Chat rail should work on Railway too.
- **Chat API:** Currently at `/api/chat`, uses Anthropic Claude with usage guards (daily budget, IP limits). The rail calls this same endpoint.
- **LFW pattern:** Chat rail follows the assistant-rail from `/Users/braydon/projects/experiments/lfw-ai-graph-crm/public/js/components/assistant-rail.js` — 440px default, resize, collapse, per-scope threads.
- **Model for extraction:** Plan uses `claude-haiku-4-5-20251001` for classification. Costs ~$0.02/day.
- **No TDD for this feature** — the plan has full code inline. Test by running the pipeline and verifying the UI renders.
- **Stale drift tasks** — There are ~16 old drift/harden tasks in the workgraph from previous milestones. Ignore them; they don't block wisdom tasks.
