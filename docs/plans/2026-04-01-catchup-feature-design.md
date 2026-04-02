# Catchup Feature Design

**Date:** 2026-04-01  
**Status:** Approved

## Problem

Users who are away for days at a time (vacation, weekend, etc.) have no way to get a coherent overview of what happened during their absence. The daily briefing is 24h only. Reading back through individual daily reports is tedious and doesn't surface cross-day through-lines.

## Solution

A new **Catchup** nav item that accepts a time window (preset or custom date range), runs a meta-synthesis over the stored daily reports for that window, and returns a "here's what you missed" view — informational only, no contribution suggestions.

---

## Architecture

### Backend: `backend/vibez/synthesis.py`

New function `run_catchup_synthesis(start_date, end_date, config)`:

1. Pull stored daily reports from SQLite for the date range.
2. For each day in the range with no stored report, note the gap explicitly in the prompt.
3. Build a meta-synthesis prompt (see Prompt Design below).
4. Call Claude. Return structured JSON.
5. No contributions in the output — informational only.

### Backend: `backend/vibez/db.py`

New `catchup_cache` SQLite table:

```sql
CREATE TABLE IF NOT EXISTS catchup_cache (
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (start_date, end_date)
);
```

Helper functions:
- `get_catchup_cache(start_date, end_date)` — returns cached result or None (also returns None if stale=1)
- `set_catchup_cache(start_date, end_date, result_json)` — upserts with current timestamp
- `invalidate_catchup_cache(date)` — marks stale=1 for any cached window containing `date` (called when a new daily report is written)

### API: `dashboard/src/app/api/catchup/route.ts`

GET endpoint: `?start=YYYY-MM-DD&end=YYYY-MM-DD`

1. Validate params.
2. Check `catchup_cache` — return cached JSON if found and not stale.
3. On miss: spawn `run_catchup_synthesis` via the same subprocess pattern used by existing scripts.
4. Cache and return result.

### UI: `dashboard/src/app/catchup/page.tsx`

- Preset buttons: **Weekend**, **3 Days**, **1 Week**, **2 Weeks**
- Custom date range picker below presets
- On selection: call API, show loading state (synthesis takes a few seconds on first run)
- Render output sections in order (see Output Shape below)
- Reuse existing card/section components from Briefing page wherever they apply

### Nav

Add **Catchup** link to existing nav alongside Chat, Briefing, Stats, etc.

---

## Output Shape

```json
{
  "catchup_memo": "3–5 sentence headline narrative of the period",
  "conversation_arcs": [
    {
      "title": "...",
      "participants": ["..."],
      "core_exchange": "...",
      "why_it_matters": "...",
      "likely_next": "..."
    }
  ],
  "themes": ["recurring-topic-slug", "..."],
  "trends": {
    "emerging": ["..."],
    "fading": ["..."],
    "shifts": "one sentence on the arc of the period"
  },
  "links": [
    {
      "url": "...",
      "title": "...",
      "category": "tool|repo|article|discussion",
      "relevance": "..."
    }
  ],
  "people_activity": [
    {
      "name": "...",
      "role": "what they drove during this period"
    }
  ],
  "unresolved_threads": [
    {
      "title": "...",
      "status": "brief note on where it stands"
    }
  ],
  "hot_on_return": [
    {
      "title": "...",
      "why_hot": "still active in last 24–48h"
    }
  ]
}
```

**Rendering order on the page:**
1. `catchup_memo` — headline card at top
2. `hot_on_return` — "Re-engage here first" section (actionable, high priority)
3. `conversation_arcs` — the meaty narrative content
4. `unresolved_threads` — what's still open
5. `people_activity` — who drove things while you were away
6. `themes` — rendered as tags
7. `trends` — emerging/fading/shifts
8. `links` — articles, repos, tools shared

---

## Meta-Synthesis Prompt Design

Input to Claude is each day's condensed daily report output — not raw messages. For a 7-day window: ~7 × 500 tokens, well within a single context window.

```
You are a synthesis analyst. The user was away for {n} days ({start_date} to {end_date}).
Below are the daily briefings for that period.

Identify through-lines, what escalated, what resolved, who drove the conversations,
what is still unresolved, and what is still hot as of the most recent day.
Informational only — no contribution suggestions.

[DAY 1 - 2026-03-25]
Daily memo: ...
Conversation arcs: ...
Trends: ...
Links: ...

[DAY 2 - 2026-03-26]
...

[Note: No data available for 2026-03-27]

...

Respond with JSON matching this schema: { catchup_memo, conversation_arcs, themes,
trends, links, people_activity, unresolved_threads, hot_on_return }
```

`hot_on_return` is derived by crossing the window's arc/thread list against the last 24–48h of the most recent daily report, identifying what's still active.

---

## Cache Invalidation

- Cache key: `(start_date, end_date)`
- On hit: return immediately (no LLM call)
- On miss: generate, cache, return
- Stale trigger: any time `run_daily_synthesis` writes a new report, call `invalidate_catchup_cache(report_date)` to mark affected windows stale — they'll regenerate on next request

---

## What's Out of Scope

- Contribution suggestions (excluded by design — informational only)
- Real-time streaming of synthesis output (use a loading state instead)
- Catchup over raw messages (meta-synthesis over daily reports is the approach)
