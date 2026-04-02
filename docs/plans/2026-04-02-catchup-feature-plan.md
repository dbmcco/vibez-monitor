# Catchup Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Catchup nav item where users pick a time window (preset or custom date range) and get a meta-synthesized "what you missed" briefing over stored daily reports.

**Architecture:** On-demand meta-synthesis via Anthropic SDK — reads stored daily reports for the window, builds a prompt, calls Claude, caches the result in SQLite keyed by `(start_date, end_date)`. Cache is invalidated whenever a new daily report lands within the window.

**Tech Stack:** Python (SQLite schema + invalidation), TypeScript/Next.js (cache helpers, synthesis, API route, UI), `better-sqlite3`, `@anthropic-ai/sdk`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `backend/vibez/db.py` | Add `catchup_cache` table to SCHEMA + migration + `invalidate_catchup_for_date()` |
| Modify | `backend/vibez/synthesis.py` | Call `invalidate_catchup_for_date()` after saving daily report |
| Create | `backend/tests/test_catchup_db.py` | Tests for new db functions |
| Create | `dashboard/src/lib/catchup.ts` | Cache helpers (writable DB), report fetching, prompt builder, synthesis |
| Create | `dashboard/src/app/api/catchup/route.ts` | GET endpoint — cache check, synthesis on miss |
| Create | `dashboard/src/app/catchup/page.tsx` | UI — preset buttons, date inputs, results rendering |
| Modify | `dashboard/src/components/Nav.tsx` | Add Catchup link + PAGE_INTENT entry |

---

## Task 1: Add `catchup_cache` table to Python db

**Files:**
- Modify: `backend/vibez/db.py`
- Modify: `backend/vibez/synthesis.py`
- Create: `backend/tests/test_catchup_db.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_catchup_db.py`:

```python
# ABOUTME: Tests for catchup_cache table creation and invalidation logic.
# ABOUTME: Covers schema presence, invalidation targeting, and no-op edge cases.
import json
import pytest
from vibez.db import init_db, get_connection, invalidate_catchup_for_date


def _seed_cache(db_path, entries):
    """entries: list of (start_date, end_date, stale)"""
    init_db(db_path)
    conn = get_connection(db_path)
    for start, end, stale in entries:
        conn.execute(
            """INSERT INTO catchup_cache (start_date, end_date, result_json, created_at, stale)
               VALUES (?, ?, ?, ?, ?)""",
            (start, end, json.dumps({"catchup_memo": "test"}), 1000000, stale),
        )
    conn.commit()
    conn.close()


def test_catchup_cache_table_exists(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    conn.close()
    assert "catchup_cache" in tables


def test_invalidate_marks_containing_windows_stale(tmp_db):
    _seed_cache(tmp_db, [
        ("2026-03-20", "2026-03-26", 0),  # ends before 03-27 → stays fresh
        ("2026-03-24", "2026-03-30", 0),  # contains 03-27 → stale
        ("2026-03-28", "2026-03-31", 0),  # starts after 03-27 → stays fresh
    ])
    invalidate_catchup_for_date(tmp_db, "2026-03-27")
    conn = get_connection(tmp_db)
    rows = {
        (r[0], r[1]): r[2]
        for r in conn.execute(
            "SELECT start_date, end_date, stale FROM catchup_cache"
        ).fetchall()
    }
    conn.close()
    assert rows[("2026-03-20", "2026-03-26")] == 0
    assert rows[("2026-03-24", "2026-03-30")] == 1
    assert rows[("2026-03-28", "2026-03-31")] == 0


def test_invalidate_no_op_when_empty(tmp_db):
    init_db(tmp_db)
    # Should not raise
    invalidate_catchup_for_date(tmp_db, "2026-03-27")


def test_invalidate_does_not_touch_already_stale(tmp_db):
    _seed_cache(tmp_db, [
        ("2026-03-24", "2026-03-30", 1),  # already stale
    ])
    invalidate_catchup_for_date(tmp_db, "2026-03-27")
    conn = get_connection(tmp_db)
    row = conn.execute(
        "SELECT stale FROM catchup_cache WHERE start_date = '2026-03-24'"
    ).fetchone()
    conn.close()
    assert row[0] == 1  # still stale, no change
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
backend/.venv/bin/python -m pytest backend/tests/test_catchup_db.py -v
```

Expected: `ImportError` — `cannot import name 'invalidate_catchup_for_date'`

- [ ] **Step 3: Add `catchup_cache` to SCHEMA in `db.py`**

In `backend/vibez/db.py`, find the end of the `SCHEMA` string (just before the closing `"""`). Add after the `wisdom_recommendations` table:

```python
CREATE TABLE IF NOT EXISTS catchup_cache (
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (start_date, end_date)
);
```

- [ ] **Step 4: Add migration for existing databases in `_migrate()`**

In `backend/vibez/db.py`, inside `_migrate()`, after the existing `if "wisdom_topics" not in existing_tables` block, add:

```python
    if "catchup_cache" not in existing_tables:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS catchup_cache (
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                stale INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (start_date, end_date)
            );
        """)
        changed = True
```

- [ ] **Step 5: Add `invalidate_catchup_for_date()` to `db.py`**

Add this function after `init_db()` in `backend/vibez/db.py`:

```python
def invalidate_catchup_for_date(db_path: str | Path, date: str) -> None:
    """Mark catchup cache entries stale if their window contains the given date."""
    conn = get_connection(db_path)
    conn.execute(
        "UPDATE catchup_cache SET stale = 1 WHERE start_date <= ? AND end_date >= ?",
        (date, date),
    )
    conn.commit()
    conn.close()
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
backend/.venv/bin/python -m pytest backend/tests/test_catchup_db.py -v
```

Expected: all 4 tests PASS

- [ ] **Step 7: Hook invalidation into `save_daily_report()` in `synthesis.py`**

In `backend/vibez/synthesis.py`, update the import at line 15:

```python
from vibez.db import get_connection, init_db, invalidate_catchup_for_date
```

Then in `save_daily_report()`, after `conn.close()` and after the `upsert_links` call at the end of the function, add:

```python
    invalidate_catchup_for_date(db_path, report_date)
```

- [ ] **Step 8: Run full backend test suite to confirm no regressions**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
backend/.venv/bin/python -m pytest backend/tests -q
```

Expected: all tests pass (no failures, no errors)

- [ ] **Step 9: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/db.py backend/vibez/synthesis.py backend/tests/test_catchup_db.py
git commit -m "feat: add catchup_cache table and invalidation logic"
```

---

## Task 2: Create `dashboard/src/lib/catchup.ts`

**Files:**
- Create: `dashboard/src/lib/catchup.ts`

This file is server-only (used by the API route). It contains: cache helpers, report fetching, prompt builder, and Anthropic synthesis.

- [ ] **Step 1: Create the file**

Create `dashboard/src/lib/catchup.ts`:

```typescript
// ABOUTME: Catchup feature — SQLite cache helpers, daily report fetching, prompt builder, synthesis.
// ABOUTME: Server-only. Called by /api/catchup. Uses better-sqlite3 and @anthropic-ai/sdk.

import Database from "better-sqlite3";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

const DB_PATH =
  process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

const CATCHUP_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS catchup_cache (
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (start_date, end_date)
);
`;

function withWriteDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(CATCHUP_CACHE_SCHEMA);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export interface CatchupArc {
  title: string;
  participants: string[];
  core_exchange: string;
  why_it_matters: string;
  likely_next: string;
}

export interface CatchupLink {
  url: string;
  title: string;
  category: string;
  relevance: string;
}

export interface CatchupResult {
  catchup_memo: string;
  conversation_arcs: CatchupArc[];
  themes: string[];
  trends: {
    emerging: string[];
    fading: string[];
    shifts: string;
  };
  links: CatchupLink[];
  people_activity: Array<{ name: string; role: string }>;
  unresolved_threads: Array<{ title: string; status: string }>;
  hot_on_return: Array<{ title: string; why_hot: string }>;
}

const EMPTY_RESULT: CatchupResult = {
  catchup_memo: "",
  conversation_arcs: [],
  themes: [],
  trends: { emerging: [], fading: [], shifts: "" },
  links: [],
  people_activity: [],
  unresolved_threads: [],
  hot_on_return: [],
};

export function getCatchupCache(
  startDate: string,
  endDate: string
): CatchupResult | null {
  return withWriteDb((db) => {
    const row = db
      .prepare(
        "SELECT result_json FROM catchup_cache WHERE start_date = ? AND end_date = ? AND stale = 0"
      )
      .get(startDate, endDate) as { result_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.result_json) as CatchupResult;
    } catch {
      return null;
    }
  });
}

export function setCatchupCache(
  startDate: string,
  endDate: string,
  result: CatchupResult
): void {
  withWriteDb((db) => {
    db.prepare(
      `INSERT OR REPLACE INTO catchup_cache (start_date, end_date, result_json, created_at, stale)
       VALUES (?, ?, ?, ?, 0)`
    ).run(startDate, endDate, JSON.stringify(result), Date.now());
  });
}

interface DailyReportRow {
  report_date: string;
  daily_memo: string | null;
  conversation_arcs: string | null;
  trends: string | null;
  stats: string | null; // stores links[] per save_daily_report convention
}

export function getReportsForRange(
  startDate: string,
  endDate: string
): DailyReportRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");
  try {
    return db
      .prepare(
        `SELECT report_date, daily_memo, conversation_arcs, trends, stats
         FROM daily_reports
         WHERE report_date >= ? AND report_date <= ?
         ORDER BY report_date ASC`
      )
      .all(startDate, endDate) as DailyReportRow[];
  } finally {
    db.close();
  }
}

function allDatesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function tryParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function buildCatchupPrompt(
  reports: DailyReportRow[],
  startDate: string,
  endDate: string
): string {
  const dates = allDatesInRange(startDate, endDate);
  const byDate = new Map(reports.map((r) => [r.report_date, r]));
  const lastDate = dates[dates.length - 1];
  const nDays = dates.length;

  const daysBlock = dates
    .map((date) => {
      const r = byDate.get(date);
      if (!r) return `[${date}]\nNo data available for this date.\n`;

      const arcs = tryParseJson<Array<{ title?: string; participants?: string[] }>>(
        r.conversation_arcs,
        []
      );
      const trends = tryParseJson<{
        emerging?: string[];
        fading?: string[];
        shifts?: string;
      }>(r.trends, {});
      const links = tryParseJson<Array<{ title?: string; url?: string }>>(
        r.stats,
        []
      );

      const arcsText =
        arcs.length > 0
          ? arcs
              .map(
                (a) =>
                  `  - ${a.title ?? "Untitled"} (${(a.participants ?? []).join(", ")})`
              )
              .join("\n")
          : "  (none)";

      const trendsText = [
        trends.emerging?.length
          ? `emerging: ${trends.emerging.join(", ")}`
          : null,
        trends.fading?.length
          ? `fading: ${trends.fading.join(", ")}`
          : null,
        trends.shifts ? `shifts: ${trends.shifts}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      const linksText =
        links.length > 0
          ? links
              .map((l) => `  - ${l.title ?? l.url ?? "link"}`)
              .join("\n")
          : "  (none)";

      return `[${date}]
Daily memo: ${r.daily_memo ?? "(none)"}
Arcs:
${arcsText}
Trends: ${trendsText || "(none)"}
Links:
${linksText}`;
    })
    .join("\n\n");

  return `The user was away from ${startDate} to ${endDate} (${nDays} day${nDays === 1 ? "" : "s"}).

Below are the daily briefings for that period. Identify cross-day through-lines, what escalated, what resolved, who drove conversations, what is still unresolved, and what is hot as of the last day (${lastDate}).

Informational only — no contribution suggestions.

${daysBlock}

Respond with JSON matching this exact schema:
{
  "catchup_memo": "<3-5 sentence headline narrative of the entire period>",
  "conversation_arcs": [
    {
      "title": "<arc title>",
      "participants": ["<name>"],
      "core_exchange": "<what was actually debated or built>",
      "why_it_matters": "<why this matters for the community>",
      "likely_next": "<what is likely to happen next>"
    }
  ],
  "themes": ["<recurring-topic-slug>"],
  "trends": {
    "emerging": ["<new topic gaining traction>"],
    "fading": ["<topic losing steam>"],
    "shifts": "<one sentence on the arc of this period>"
  },
  "links": [
    {
      "url": "<url>",
      "title": "<title>",
      "category": "<tool|repo|article|discussion>",
      "relevance": "<why it matters>"
    }
  ],
  "people_activity": [
    {
      "name": "<person name>",
      "role": "<what they drove during this period>"
    }
  ],
  "unresolved_threads": [
    {
      "title": "<thread title>",
      "status": "<where it stands as of ${endDate}>"
    }
  ],
  "hot_on_return": [
    {
      "title": "<arc or thread title>",
      "why_hot": "<why this is still active and worth re-engaging with first>"
    }
  ]
}

RULES:
- conversation_arcs: synthesize cross-day through-lines, not per-day summaries
- people_activity: who drove the most significant conversations; describe their specific contribution
- unresolved_threads: arcs with no clear resolution by ${endDate}
- hot_on_return: arcs active in the last 1-2 days of the window (${lastDate} and the day before if present)
- themes: short slug form e.g. "multi-agent-orchestration"
- Deduplicate links across days; keep only the most notable`;
}

function parseCatchupResult(raw: string): CatchupResult {
  try {
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)(?:```|$)/);
    if (fenceMatch) cleaned = fenceMatch[1];
    const data = JSON.parse(cleaned.trim()) as Partial<CatchupResult>;
    return { ...EMPTY_RESULT, ...data };
  } catch {
    return { ...EMPTY_RESULT };
  }
}

export async function runCatchupSynthesis(
  startDate: string,
  endDate: string
): Promise<CatchupResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const reports = getReportsForRange(startDate, endDate);
  const prompt = buildCatchupPrompt(reports, startDate, endDate);

  const client = new Anthropic({ apiKey });
  const model =
    process.env.SYNTHESIS_MODEL ??
    process.env.CLASSIFIER_MODEL ??
    "claude-sonnet-4-6";

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system:
      "You are an intelligence analyst producing a concise catchup briefing from daily reports. Informational only — no contribution suggestions. Always respond with valid JSON.",
    messages: [{ role: "user", content: prompt }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "";
  return parseCatchupResult(raw);
}
```

- [ ] **Step 2: Run lint + build to confirm no TypeScript errors**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/dashboard
npm run lint
npm run build
```

Expected: 0 errors, 0 warnings for `src/lib/catchup.ts`

- [ ] **Step 3: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/lib/catchup.ts
git commit -m "feat: add catchup lib (cache helpers, prompt builder, synthesis)"
```

---

## Task 3: Create `/api/catchup` route

**Files:**
- Create: `dashboard/src/app/api/catchup/route.ts`

- [ ] **Step 1: Create the file**

Create `dashboard/src/app/api/catchup/route.ts`:

```typescript
// ABOUTME: Catchup API route — checks SQLite cache, runs meta-synthesis on miss.
// ABOUTME: GET ?start=YYYY-MM-DD&end=YYYY-MM-DD

import { NextRequest, NextResponse } from "next/server";
import {
  getCatchupCache,
  setCatchupCache,
  runCatchupSynthesis,
} from "@/lib/catchup";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const start = request.nextUrl.searchParams.get("start");
  const end = request.nextUrl.searchParams.get("end");

  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    return NextResponse.json(
      { error: "start and end are required in YYYY-MM-DD format" },
      { status: 400 }
    );
  }

  if (start > end) {
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 }
    );
  }

  try {
    const cached = getCatchupCache(start, end);
    if (cached) {
      return NextResponse.json({ result: cached, cached: true });
    }

    const result = await runCatchupSynthesis(start, end);
    setCatchupCache(start, end, result);
    return NextResponse.json({ result, cached: false });
  } catch (error) {
    console.error("catchup api failed", error);
    return NextResponse.json(
      { error: "synthesis failed" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Run lint + build**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/dashboard
npm run lint
npm run build
```

Expected: 0 errors

- [ ] **Step 3: Manual smoke test**

With the dev server running (`npm run dev`), hit:
```
curl "http://localhost:3100/api/catchup?start=2026-03-25&end=2026-03-31"
```

Expected: JSON with `result` and `cached: false` on first call, `cached: true` on repeat.
If no daily reports exist for that range: `catchup_memo` will be empty strings and empty arrays (the `EMPTY_RESULT` fallback).

- [ ] **Step 4: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/app/api/catchup/route.ts
git commit -m "feat: add /api/catchup endpoint with cache-check and synthesis"
```

---

## Task 4: Create `/catchup` page

**Files:**
- Create: `dashboard/src/app/catchup/page.tsx`

- [ ] **Step 1: Create the file**

Create `dashboard/src/app/catchup/page.tsx`:

```tsx
// ABOUTME: Catchup page — preset + custom date range window selector with on-demand synthesis.
// ABOUTME: Renders catchup_memo, hot_on_return, arcs, unresolved_threads, people, themes, trends, links.

"use client";

import { useState } from "react";

interface CatchupArc {
  title: string;
  participants: string[];
  core_exchange: string;
  why_it_matters: string;
  likely_next: string;
}

interface CatchupLink {
  url: string;
  title: string;
  category: string;
  relevance: string;
}

interface CatchupResult {
  catchup_memo: string;
  conversation_arcs: CatchupArc[];
  themes: string[];
  trends: {
    emerging: string[];
    fading: string[];
    shifts: string;
  };
  links: CatchupLink[];
  people_activity: Array<{ name: string; role: string }>;
  unresolved_threads: Array<{ title: string; status: string }>;
  hot_on_return: Array<{ title: string; why_hot: string }>;
}

const PRESETS = [
  { key: "weekend", label: "Weekend" },
  { key: "3days", label: "3 Days" },
  { key: "1week", label: "1 Week" },
  { key: "2weeks", label: "2 Weeks" },
] as const;

type PresetKey = (typeof PRESETS)[number]["key"];

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function computePresetDates(preset: PresetKey): { start: string; end: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (preset === "weekend") {
    // Most recently completed Saturday + Sunday
    const day = today.getDay(); // 0=Sun, 6=Sat
    const daysToLastSun = day === 0 ? 7 : day;
    const lastSun = new Date(today);
    lastSun.setDate(today.getDate() - daysToLastSun);
    const lastSat = new Date(lastSun);
    lastSat.setDate(lastSun.getDate() - 1);
    return { start: fmt(lastSat), end: fmt(lastSun) };
  }

  const daysMap: Record<string, number> = {
    "3days": 3,
    "1week": 7,
    "2weeks": 14,
  };
  const days = daysMap[preset] ?? 7;
  const start = new Date(today);
  start.setDate(today.getDate() - days);
  const end = new Date(today);
  end.setDate(today.getDate() - 1);
  return { start: fmt(start), end: fmt(end) };
}

export default function CatchupPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [activePreset, setActivePreset] = useState<PresetKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CatchupResult | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePreset(preset: PresetKey) {
    const dates = computePresetDates(preset);
    setStart(dates.start);
    setEnd(dates.end);
    setActivePreset(preset);
  }

  async function handleGenerate() {
    if (!start || !end) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/catchup?start=${start}&end=${end}`);
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Request failed");
      }
      const body = (await res.json()) as {
        result: CatchupResult;
        cached: boolean;
      };
      setResult(body.result);
      setFromCache(body.cached);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Catchup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Get up to speed on what happened while you were away.
        </p>
      </div>

      {/* Window selector */}
      <div className="vibe-panel rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePreset(p.key)}
              className={`vibe-button rounded px-3 py-1.5 text-sm ${
                activePreset === p.key ? "ring-2 ring-cyan-400/60" : ""
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">From</label>
            <input
              type="date"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setActivePreset(null);
              }}
              className="vibe-input rounded px-2 py-1 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">To</label>
            <input
              type="date"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                setActivePreset(null);
              }}
              className="vibe-input rounded px-2 py-1 text-sm"
            />
          </div>
          <button
            onClick={() => void handleGenerate()}
            disabled={!start || !end || loading}
            className="vibe-button rounded px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {loading ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <span className="vibe-spinner inline-block h-4 w-4 rounded-full border-2 border-slate-600 border-t-cyan-400" />
          Synthesizing {start} → {end}…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded border border-red-700/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-6">
          {fromCache && (
            <p className="text-xs text-slate-500">Cached result</p>
          )}

          {/* Catchup memo */}
          {result.catchup_memo && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
                What You Missed
              </h2>
              <p className="text-sm text-slate-200 leading-relaxed">
                {result.catchup_memo}
              </p>
            </div>
          )}

          {/* Hot on return */}
          {result.hot_on_return.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-400">
                Re-Engage Here First
              </h2>
              <ul className="space-y-3">
                {result.hot_on_return.map((item, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-slate-100">
                      {item.title}
                    </span>
                    <span className="text-xs text-slate-400">
                      {item.why_hot}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Conversation arcs */}
          {result.conversation_arcs.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Conversation Arcs
              </h2>
              {result.conversation_arcs.map((arc, i) => (
                <div key={i} className="vibe-panel rounded-lg p-4 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-100">
                      {arc.title}
                    </h3>
                    {arc.participants.length > 0 && (
                      <span className="text-xs text-slate-500">
                        {arc.participants.join(", ")}
                      </span>
                    )}
                  </div>
                  {arc.core_exchange && (
                    <p className="text-sm text-slate-300">{arc.core_exchange}</p>
                  )}
                  {arc.why_it_matters && (
                    <p className="text-xs text-slate-400">
                      <span className="text-slate-500">Why it matters: </span>
                      {arc.why_it_matters}
                    </p>
                  )}
                  {arc.likely_next && (
                    <p className="text-xs text-slate-400">
                      <span className="text-slate-500">Likely next: </span>
                      {arc.likely_next}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Unresolved threads */}
          {result.unresolved_threads.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Still Open
              </h2>
              <ul className="space-y-3">
                {result.unresolved_threads.map((t, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-slate-100">
                      {t.title}
                    </span>
                    <span className="text-xs text-slate-400">{t.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* People activity */}
          {result.people_activity.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Who Drove Things
              </h2>
              <ul className="space-y-2">
                {result.people_activity.map((p, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="text-sm font-medium text-slate-100 min-w-[100px]">
                      {p.name}
                    </span>
                    <span className="text-xs text-slate-400">{p.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Themes */}
          {result.themes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {result.themes.map((theme, i) => (
                <span key={i} className="vibe-chip rounded px-2 py-0.5 text-xs">
                  {theme}
                </span>
              ))}
            </div>
          )}

          {/* Trends */}
          {(result.trends.emerging.length > 0 ||
            result.trends.fading.length > 0 ||
            result.trends.shifts) && (
            <div className="vibe-panel rounded-lg p-4 space-y-2">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Trends
              </h2>
              {result.trends.shifts && (
                <p className="text-sm text-slate-300 italic">
                  {result.trends.shifts}
                </p>
              )}
              {result.trends.emerging.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500">Emerging:</span>
                  {result.trends.emerging.map((t, i) => (
                    <span
                      key={i}
                      className="badge-warm rounded px-1.5 py-0.5 text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {result.trends.fading.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500">Fading:</span>
                  {result.trends.fading.map((t, i) => (
                    <span
                      key={i}
                      className="badge-archive rounded px-1.5 py-0.5 text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Links */}
          {result.links.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Links Shared
              </h2>
              <ul className="space-y-3">
                {result.links.map((link, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-cyan-400 hover:underline"
                    >
                      {link.title || link.url}
                    </a>
                    {link.relevance && (
                      <span className="text-xs text-slate-400">
                        {link.relevance}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run lint + build**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/dashboard
npm run lint
npm run build
```

Expected: 0 errors

- [ ] **Step 3: Manual verify in browser**

Start dev server: `cd dashboard && npm run dev`
Navigate to `http://localhost:3100/catchup`

Verify:
- Page loads with "Catchup" heading
- Preset buttons are visible (Weekend, 3 Days, 1 Week, 2 Weeks)
- Clicking a preset populates the date inputs
- Date inputs can be edited directly (clears preset highlight)
- Generate button is disabled when dates are empty
- Clicking Generate with valid dates shows loading spinner, then results

- [ ] **Step 4: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/app/catchup/page.tsx
git commit -m "feat: add catchup page with preset buttons and date range picker"
```

---

## Task 5: Add Catchup to nav

**Files:**
- Modify: `dashboard/src/components/Nav.tsx`

- [ ] **Step 1: Add nav link and intent**

In `dashboard/src/components/Nav.tsx`:

Find `ALL_LINKS` and add the Catchup entry after Briefing:

```typescript
const ALL_LINKS = [
  { href: "/briefing", label: "Briefing" },
  { href: "/catchup", label: "Catchup" },   // add this line
  { href: "/wisdom", label: "Wisdom" },
  { href: "/links", label: "Links" },
  { href: "/stats", label: "Stats" },
  { href: "/spaces", label: "Groups" },
  { href: "/settings", label: "Settings" },
];
```

Add an entry to `PAGE_INTENT` after the `/briefing/trends` entry:

```typescript
  "/catchup":
    "Time-window synthesis: get up to speed on what happened while you were away.",
```

- [ ] **Step 2: Run lint + build**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/dashboard
npm run lint
npm run build
```

Expected: 0 errors

- [ ] **Step 3: Verify in browser**

Navigate to `http://localhost:3100/briefing` — confirm "Catchup" appears in the nav bar between Briefing and Wisdom. Click it — lands on `/catchup`. The intent bar at the bottom of the nav shows the catchup intent string.

- [ ] **Step 4: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/components/Nav.tsx
git commit -m "feat: add Catchup nav item and page intent"
```

---

## Self-Review

**Spec coverage check:**
- ✅ New nav item → Task 5
- ✅ Preset buttons (Weekend, 3 Days, 1 Week, 2 Weeks) → Task 4
- ✅ Custom date range picker → Task 4
- ✅ On-demand meta-synthesis over daily reports → Task 2 (`runCatchupSynthesis`)
- ✅ SQLite caching by (start_date, end_date) → Task 2 (`getCatchupCache`, `setCatchupCache`)
- ✅ Cache invalidation when new daily report lands → Task 1 (`invalidate_catchup_for_date` + hook in `save_daily_report`)
- ✅ Informational only, no contributions → prompt RULES section
- ✅ `catchup_memo` → output shape + page rendering
- ✅ `conversation_arcs` → output shape + page rendering
- ✅ `themes` → output shape + page rendering
- ✅ `trends` → output shape + page rendering
- ✅ `links` → output shape + page rendering
- ✅ `people_activity` → output shape + page rendering
- ✅ `unresolved_threads` → output shape + page rendering
- ✅ `hot_on_return` → output shape + page rendering
- ✅ Gap handling (missing days noted in prompt) → `buildCatchupPrompt` uses `allDatesInRange`

**No placeholders found.**

**Type consistency:** `CatchupResult` is defined in `catchup.ts` (server) and inlined in `catchup/page.tsx` (client) following the existing project pattern. `DailyReportRow` internal type is not exported — only used within `catchup.ts`. `buildCatchupPrompt` takes `DailyReportRow[]` which matches return type of `getReportsForRange`. All consistent.
