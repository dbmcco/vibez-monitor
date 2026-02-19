# Adaptive Intelligence Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dismiss/learn feedback loop, bookmark queue, git work context summarizer, and autonomous analyst agent to vibez-monitor.

**Architecture:** Four backend modules (feedback DB, work_context.py, analyst.py, updated classifier/synthesis prompts) + four dashboard changes (dismiss/bookmark buttons, /queue page, /analyst page, settings expansion). All data flows through existing SQLite DB. Perplexity API called directly from Python via urllib (same pattern as Beeper API calls).

**Tech Stack:** Python 3.14 (backend), Next.js 16 / React 19 / TypeScript (dashboard), SQLite (DB), Anthropic API (Sonnet for synthesis/questions/PoV, Haiku for git summaries), Perplexity API (sonar-reasoning for research)

**Reference files:**
- DB schema: `backend/vibez/db.py`
- Classifier: `backend/vibez/classifier.py`
- Synthesis: `backend/vibez/synthesis.py`
- Config: `backend/vibez/config.py`
- Dashboard DB: `dashboard/src/lib/db.ts`
- Nav: `dashboard/src/components/Nav.tsx`
- Contribute page: `dashboard/src/app/contribute/page.tsx`
- ContributionCard: `dashboard/src/components/ContributionCard.tsx`
- BriefingView: `dashboard/src/components/BriefingView.tsx`
- Settings: `dashboard/src/app/settings/page.tsx`
- Settings API: `dashboard/src/app/api/settings/route.ts`
- Contributions API: `dashboard/src/app/api/contributions/route.ts`
- Run synthesis: `backend/scripts/run_synthesis.py`
- Tests: `backend/tests/conftest.py`, `test_db.py`, `test_classifier.py`, `test_synthesis.py`

---

## Task 1: User Feedback DB Schema

**Files:**
- Modify: `backend/vibez/db.py:7-58` (add table to SCHEMA), `backend/vibez/db.py:92-99` (add migration)
- Test: `backend/tests/test_db.py`

**Step 1: Write the failing test**

Add to `backend/tests/test_db.py`:

```python
def test_user_feedback_table_exists(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='user_feedback'"
    )
    assert cursor.fetchone() is not None


def test_insert_and_read_feedback(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO user_feedback (message_id, theme, action, reason)
           VALUES (?, ?, ?, ?)""",
        ("$ev1", "multi-agent-orchestration", "dismiss", "not relevant right now"),
    )
    conn.commit()
    cursor = conn.execute(
        "SELECT theme, action, reason, status FROM user_feedback WHERE message_id = ?",
        ("$ev1",),
    )
    row = cursor.fetchone()
    assert row[0] == "multi-agent-orchestration"
    assert row[1] == "dismiss"
    assert row[2] == "not relevant right now"
    assert row[3] == "active"


def test_analyst_reports_table_exists(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='analyst_reports'"
    )
    assert cursor.fetchone() is not None
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_db.py -v`
Expected: FAIL — `user_feedback` and `analyst_reports` tables don't exist

**Step 3: Add tables to schema**

In `backend/vibez/db.py`, add after the `sync_state` table (line 58, before the closing `"""`):

```sql
CREATE TABLE IF NOT EXISTS user_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    theme TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_action ON user_feedback(action);
CREATE INDEX IF NOT EXISTS idx_feedback_theme ON user_feedback(theme);

CREATE TABLE IF NOT EXISTS analyst_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,
    questions_json TEXT NOT NULL DEFAULT '[]',
    research_json TEXT NOT NULL DEFAULT '[]',
    pov_json TEXT NOT NULL DEFAULT '[]',
    pov_md TEXT NOT NULL DEFAULT '',
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analyst_date ON analyst_reports(report_date);
```

Also add a migration in `_migrate()` for existing databases:

```python
def _migrate(conn: sqlite3.Connection) -> None:
    """Run schema migrations on existing databases."""
    cls_cols = {row[1] for row in conn.execute("PRAGMA table_info(classifications)")}
    if "contribution_themes" not in cls_cols:
        conn.execute(
            "ALTER TABLE classifications ADD COLUMN contribution_themes TEXT NOT NULL DEFAULT '[]'"
        )
        conn.commit()

    # Create new tables if they don't exist (for existing DBs)
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    if "user_feedback" not in tables:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS user_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT,
                theme TEXT NOT NULL,
                action TEXT NOT NULL,
                reason TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_feedback_action ON user_feedback(action);
            CREATE INDEX IF NOT EXISTS idx_feedback_theme ON user_feedback(theme);
        """)
    if "analyst_reports" not in tables:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS analyst_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_date DATE NOT NULL,
                questions_json TEXT NOT NULL DEFAULT '[]',
                research_json TEXT NOT NULL DEFAULT '[]',
                pov_json TEXT NOT NULL DEFAULT '[]',
                pov_md TEXT NOT NULL DEFAULT '',
                generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_analyst_date ON analyst_reports(report_date);
        """)
```

Also update `test_init_db_creates_tables` to include the new tables:

```python
def test_init_db_creates_tables(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    tables = [row[0] for row in cursor.fetchall()]
    assert "messages" in tables
    assert "classifications" in tables
    assert "daily_reports" in tables
    assert "value_config" in tables
    assert "sync_state" in tables
    assert "user_feedback" in tables
    assert "analyst_reports" in tables
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_db.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/db.py backend/tests/test_db.py
git commit -m "feat: add user_feedback and analyst_reports tables"
```

---

## Task 2: Feedback API (Dashboard Backend)

**Files:**
- Create: `dashboard/src/app/api/feedback/route.ts`
- Modify: `dashboard/src/lib/db.ts` (add write DB helper, feedback queries)

**Step 1: Add writable DB helper and feedback queries to db.ts**

In `dashboard/src/lib/db.ts`, the current `getDb()` opens readonly. Add a writable version and feedback functions:

```typescript
// After existing getDb() function (line 11):
export function getWriteDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return db;
}

// After existing getValueConfig() function (line 117):
export interface UserFeedback {
  id: number;
  message_id: string | null;
  theme: string;
  action: string;
  reason: string | null;
  status: string;
  created_at: string;
}

export function addFeedback(
  messageId: string | null,
  theme: string,
  action: string,
  reason?: string
): void {
  const db = getWriteDb();
  db.prepare(
    "INSERT INTO user_feedback (message_id, theme, action, reason) VALUES (?, ?, ?, ?)"
  ).run(messageId, theme, action, reason || null);
  db.close();
}

export function getFeedback(action?: string, status?: string): UserFeedback[] {
  const db = getDb();
  let query = "SELECT * FROM user_feedback WHERE 1=1";
  const params: unknown[] = [];
  if (action) {
    query += " AND action = ?";
    params.push(action);
  }
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  query += " ORDER BY created_at DESC";
  const rows = db.prepare(query).all(...params) as UserFeedback[];
  db.close();
  return rows;
}

export function updateFeedbackStatus(id: number, status: string): void {
  const db = getWriteDb();
  db.prepare("UPDATE user_feedback SET status = ? WHERE id = ?").run(status, id);
  db.close();
}

export function deleteFeedback(id: number): void {
  const db = getWriteDb();
  db.prepare("DELETE FROM user_feedback WHERE id = ?").run(id);
  db.close();
}

export function getDismissedThemes(): { theme: string; count: number }[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT theme, COUNT(*) as count FROM user_feedback WHERE action = 'dismiss' GROUP BY theme ORDER BY count DESC"
    )
    .all() as { theme: string; count: number }[];
  db.close();
  return rows;
}
```

Also update the existing settings API (`dashboard/src/app/api/settings/route.ts`) to use `getWriteDb`:

```typescript
import { getValueConfig, getWriteDb } from "@/lib/db";
// ... and replace `new Database(DB_PATH)` with `getWriteDb()` in the PUT handler
```

**Step 2: Create the feedback API route**

Create `dashboard/src/app/api/feedback/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { addFeedback, getFeedback, updateFeedbackStatus, deleteFeedback, getDismissedThemes } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || undefined;
    const status = searchParams.get("status") || undefined;
    const dismissed = searchParams.get("dismissed");

    if (dismissed === "themes") {
      return NextResponse.json({ themes: getDismissedThemes() });
    }

    const feedback = getFeedback(action, status);
    return NextResponse.json({ feedback });
  } catch {
    return NextResponse.json({ feedback: [] });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message_id, theme, action, reason } = body;
    if (!theme || !action) {
      return NextResponse.json({ error: "theme and action required" }, { status: 400 });
    }
    if (!["dismiss", "bookmark"].includes(action)) {
      return NextResponse.json({ error: "action must be dismiss or bookmark" }, { status: 400 });
    }
    addFeedback(message_id || null, theme, action, reason);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status } = body;
    if (!id || !status) {
      return NextResponse.json({ error: "id and status required" }, { status: 400 });
    }
    updateFeedbackStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to update feedback" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = parseInt(searchParams.get("id") || "0");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    deleteFeedback(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete feedback" }, { status: 500 });
  }
}
```

**Step 3: Run the dashboard to verify API works**

Run: `cd /Users/braydon/projects/personal/vibez-monitor/dashboard && npm run build`
Expected: Build succeeds without TypeScript errors

**Step 4: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/lib/db.ts dashboard/src/app/api/feedback/route.ts dashboard/src/app/api/settings/route.ts
git commit -m "feat: add feedback API with dismiss/bookmark CRUD"
```

---

## Task 3: Dismiss/Bookmark Buttons on Contribution Cards

**Files:**
- Modify: `dashboard/src/components/ContributionCard.tsx`
- Modify: `dashboard/src/app/contribute/page.tsx`

**Step 1: Add action buttons to ContributionCard**

Replace `dashboard/src/components/ContributionCard.tsx` entirely:

```tsx
"use client";

import { useState } from "react";
import { RelevanceBadge } from "./RelevanceBadge";

interface Props {
  message: {
    id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
    contribution_hint: string | null;
    contribution_themes: string | null;
  };
  onDismiss?: (messageId: string, theme: string) => void;
  onBookmark?: (messageId: string, theme: string) => void;
}

export function ContributionCard({ message, onDismiss, onBookmark }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const date = new Date(message.timestamp).toLocaleDateString();

  if (dismissed) return null;

  const themes: string[] = message.contribution_themes
    ? JSON.parse(message.contribution_themes)
    : [];
  const primaryTheme = themes[0] || "uncategorized";

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.(message.id, primaryTheme);
  };

  const handleBookmark = () => {
    setBookmarked(true);
    onBookmark?.(message.id, primaryTheme);
  };

  return (
    <div className={`rounded-lg border ${bookmarked ? "border-blue-700" : "border-emerald-900"} bg-zinc-900 p-4`}>
      <div className="flex items-center justify-between">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
          {message.room_name}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleBookmark}
            disabled={bookmarked}
            className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
              bookmarked
                ? "bg-blue-900 text-blue-300"
                : "bg-zinc-800 text-zinc-400 hover:bg-blue-900 hover:text-blue-300"
            }`}
            title="Bookmark for follow-up"
          >
            {bookmarked ? "Saved" : "Save"}
          </button>
          <button
            onClick={handleDismiss}
            className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-red-900 hover:text-red-300"
            title="Dismiss (system learns)"
          >
            X
          </button>
          <RelevanceBadge score={message.relevance_score} />
          <span className="text-xs text-zinc-500">{date}</span>
        </div>
      </div>
      <p className="mt-2 text-sm text-zinc-300">
        <span className="font-medium">{message.sender_name}:</span>{" "}
        {message.body.slice(0, 200)}
        {message.body.length > 200 && "..."}
      </p>
      {message.contribution_hint && (
        <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">
          {message.contribution_hint}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Wire up callbacks in contribute page**

In `dashboard/src/app/contribute/page.tsx`, add the feedback API calls:

```tsx
"use client";

import { useEffect, useState } from "react";
import { ContributionCard } from "@/components/ContributionCard";

interface Message {
  id: string; room_name: string; sender_name: string; body: string;
  timestamp: number; relevance_score: number | null;
  contribution_themes: string | null; contribution_hint: string | null;
}

interface ThemeCluster {
  theme: string;
  messages: Message[];
  latestTs: number;
}

function clusterByTheme(messages: Message[]): ThemeCluster[] {
  const themes: Record<string, Message[]> = {};
  for (const msg of messages) {
    const parsed: string[] = msg.contribution_themes ? JSON.parse(msg.contribution_themes) : [];
    if (parsed.length === 0) parsed.push("uncategorized");
    for (const theme of parsed) {
      if (!themes[theme]) themes[theme] = [];
      themes[theme].push(msg);
    }
  }
  return Object.entries(themes)
    .map(([theme, msgs]) => ({
      theme,
      messages: msgs.sort((a, b) => b.timestamp - a.timestamp),
      latestTs: Math.max(...msgs.map((m) => m.timestamp)),
    }))
    .sort((a, b) => b.messages.length - a.messages.length);
}

function freshnessBadge(ts: number): { label: string; color: string } {
  const hoursAgo = (Date.now() - ts) / (1000 * 60 * 60);
  if (hoursAgo < 24) return { label: "hot", color: "bg-red-900 text-red-300" };
  if (hoursAgo < 72) return { label: "warm", color: "bg-amber-900 text-amber-300" };
  if (hoursAgo < 168) return { label: "cool", color: "bg-blue-900 text-blue-300" };
  return { label: "archive", color: "bg-zinc-700 text-zinc-400" };
}

function sendFeedback(messageId: string, theme: string, action: "dismiss" | "bookmark") {
  fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message_id: messageId, theme, action }),
  });
}

export default function ContributePage() {
  const [contributions, setContributions] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTheme, setExpandedTheme] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/contributions")
      .then((r) => r.json())
      .then((data) => { setContributions(data.contributions); setLoading(false); });
  }, []);

  const clusters = clusterByTheme(contributions);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Contribution Opportunities</h1>
      {loading ? (<div className="text-zinc-500">Loading...</div>
      ) : clusters.length === 0 ? (<div className="text-zinc-500">No contribution opportunities yet.</div>
      ) : (
        <div className="space-y-4">
          {clusters.map((cluster) => {
            const freshness = freshnessBadge(cluster.latestTs);
            const isExpanded = expandedTheme === cluster.theme;
            return (
              <div key={cluster.theme} className="rounded-lg border border-emerald-900 bg-zinc-900">
                <button
                  onClick={() => setExpandedTheme(isExpanded ? null : cluster.theme)}
                  className="flex w-full items-center justify-between p-4 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-emerald-400">{cluster.theme}</span>
                    <span className={`rounded px-1.5 py-0.5 text-xs ${freshness.color}`}>{freshness.label}</span>
                    <span className="text-xs text-zinc-500">{cluster.messages.length} messages</span>
                  </div>
                  <span className="text-zinc-500">{isExpanded ? "\u2212" : "+"}</span>
                </button>
                {isExpanded && (
                  <div className="border-t border-zinc-800 p-4 grid gap-3 md:grid-cols-2">
                    {cluster.messages.slice(0, 10).map((msg) => (
                      <ContributionCard
                        key={msg.id}
                        message={msg}
                        onDismiss={(id, theme) => sendFeedback(id, theme, "dismiss")}
                        onBookmark={(id, theme) => sendFeedback(id, theme, "bookmark")}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Build and verify**

Run: `cd /Users/braydon/projects/personal/vibez-monitor/dashboard && npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/components/ContributionCard.tsx dashboard/src/app/contribute/page.tsx
git commit -m "feat: add dismiss/bookmark buttons to contribution cards"
```

---

## Task 4: Bookmark Queue Page

**Files:**
- Create: `dashboard/src/app/queue/page.tsx`
- Create: `dashboard/src/app/api/bookmarks/route.ts`
- Modify: `dashboard/src/lib/db.ts` (add bookmark-with-message query)
- Modify: `dashboard/src/components/Nav.tsx` (add Queue link with count badge)

**Step 1: Add bookmark query with message context to db.ts**

Add to `dashboard/src/lib/db.ts`:

```typescript
export interface BookmarkWithMessage {
  feedback_id: number;
  message_id: string | null;
  theme: string;
  reason: string | null;
  status: string;
  bookmarked_at: string;
  room_name: string | null;
  sender_name: string | null;
  body: string | null;
  timestamp: number | null;
  relevance_score: number | null;
  contribution_hint: string | null;
}

export function getBookmarks(status: string = "active"): BookmarkWithMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      f.id as feedback_id, f.message_id, f.theme, f.reason, f.status, f.created_at as bookmarked_at,
      m.room_name, m.sender_name, m.body, m.timestamp,
      c.relevance_score, c.contribution_hint
    FROM user_feedback f
    LEFT JOIN messages m ON f.message_id = m.id
    LEFT JOIN classifications c ON f.message_id = c.message_id
    WHERE f.action = 'bookmark' AND f.status = ?
    ORDER BY f.created_at DESC
  `).all(status) as BookmarkWithMessage[];
  db.close();
  return rows;
}

export function getActiveBookmarkCount(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM user_feedback WHERE action = 'bookmark' AND status = 'active'"
  ).get() as { count: number };
  db.close();
  return row.count;
}
```

**Step 2: Create bookmarks API route**

Create `dashboard/src/app/api/bookmarks/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getBookmarks, getActiveBookmarkCount, updateFeedbackStatus } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "active";
    const countOnly = searchParams.get("count");

    if (countOnly === "true") {
      return NextResponse.json({ count: getActiveBookmarkCount() });
    }

    const bookmarks = getBookmarks(status);
    return NextResponse.json({ bookmarks });
  } catch {
    return NextResponse.json({ bookmarks: [] });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status } = body;
    if (!id || !status) {
      return NextResponse.json({ error: "id and status required" }, { status: 400 });
    }
    updateFeedbackStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
```

**Step 3: Create queue page**

Create `dashboard/src/app/queue/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { RelevanceBadge } from "@/components/RelevanceBadge";

interface Bookmark {
  feedback_id: number;
  message_id: string | null;
  theme: string;
  reason: string | null;
  status: string;
  bookmarked_at: string;
  room_name: string | null;
  sender_name: string | null;
  body: string | null;
  timestamp: number | null;
  relevance_score: number | null;
  contribution_hint: string | null;
}

export default function QueuePage() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);

  const fetchBookmarks = (status: string) => {
    setLoading(true);
    fetch(`/api/bookmarks?status=${status}`)
      .then((r) => r.json())
      .then((data) => {
        setBookmarks(data.bookmarks);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchBookmarks(showDone ? "done" : "active");
  }, [showDone]);

  const markDone = async (id: number) => {
    await fetch("/api/bookmarks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "done" }),
    });
    setBookmarks((prev) => prev.filter((b) => b.feedback_id !== id));
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Follow-Up Queue</h1>
        <button
          onClick={() => setShowDone(!showDone)}
          className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
        >
          {showDone ? "Show Active" : "Show Done"}
        </button>
      </div>
      {loading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : bookmarks.length === 0 ? (
        <div className="text-zinc-500">
          {showDone ? "No completed items." : "No bookmarked items. Save contributions from the Contribute page."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {bookmarks.map((b) => (
            <div key={b.feedback_id} className="rounded-lg border border-blue-900 bg-zinc-900 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-blue-400">{b.theme}</span>
                  {b.room_name && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{b.room_name}</span>
                  )}
                  <RelevanceBadge score={b.relevance_score} />
                </div>
                <div className="flex items-center gap-2">
                  {b.timestamp && (
                    <span className="text-xs text-zinc-500">
                      {new Date(b.timestamp).toLocaleDateString()}
                    </span>
                  )}
                  {b.status === "active" && (
                    <button
                      onClick={() => markDone(b.feedback_id)}
                      className="rounded bg-emerald-900 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-800"
                    >
                      Done
                    </button>
                  )}
                </div>
              </div>
              {b.body && (
                <p className="mt-2 text-sm text-zinc-300">
                  {b.sender_name && <span className="font-medium">{b.sender_name}: </span>}
                  {b.body.slice(0, 300)}{b.body.length > 300 && "..."}
                </p>
              )}
              {b.contribution_hint && (
                <div className="mt-3 rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">
                  {b.contribution_hint}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 4: Add Queue to Nav with count badge**

Replace `dashboard/src/components/Nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const links = [
  { href: "/", label: "Live Feed" },
  { href: "/briefing", label: "Briefing" },
  { href: "/contribute", label: "Contribute" },
  { href: "/queue", label: "Queue" },
  { href: "/analyst", label: "Analyst" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    fetch("/api/bookmarks?count=true")
      .then((r) => r.json())
      .then((data) => setQueueCount(data.count || 0))
      .catch(() => {});
  }, [pathname]);

  return (
    <nav className="border-b border-zinc-800 bg-zinc-950 px-6 py-3">
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <span className="text-lg font-semibold text-zinc-100">vibez-monitor</span>
        <div className="flex gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`relative rounded-md px-3 py-1.5 text-sm transition-colors ${
                pathname === link.href
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {link.label}
              {link.href === "/queue" && queueCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white">
                  {queueCount}
                </span>
              )}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
```

**Step 5: Build and verify**

Run: `cd /Users/braydon/projects/personal/vibez-monitor/dashboard && npm run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/app/queue/page.tsx dashboard/src/app/api/bookmarks/route.ts dashboard/src/lib/db.ts dashboard/src/components/Nav.tsx
git commit -m "feat: add bookmark queue page with count badge in nav"
```

---

## Task 5: Classifier Learns from Dismissals

**Files:**
- Modify: `backend/vibez/classifier.py:47-67` (build_classify_prompt to include dismissals)
- Modify: `backend/vibez/classifier.py:174-212` (classify_messages to load dismissals)
- Test: `backend/tests/test_classifier.py`

**Step 1: Write the failing test**

Add to `backend/tests/test_classifier.py`:

```python
def test_build_classify_prompt_with_dismissed_themes():
    message = {
        "sender_name": "Sam",
        "room_name": "The vibez",
        "body": "check out this multi-agent thing",
    }
    value_config = {
        "topics": ["agentic-architecture"],
        "projects": ["Amplifier"],
    }
    dismissed = [("multi-agent-orchestration", 3), ("productivity", 1)]
    prompt = build_classify_prompt(message, value_config, dismissed_themes=dismissed)
    assert "DISMISSED THEMES" in prompt
    assert "multi-agent-orchestration: dismissed 3 times" in prompt
    assert "productivity: dismissed 1 time" in prompt
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_classifier.py::test_build_classify_prompt_with_dismissed_themes -v`
Expected: FAIL — `build_classify_prompt() got an unexpected keyword argument 'dismissed_themes'`

**Step 3: Add dismissed_themes parameter to build_classify_prompt**

In `backend/vibez/classifier.py`, modify `build_classify_prompt`:

```python
def build_classify_prompt(
    message: dict[str, Any],
    value_config: dict[str, Any],
    context_messages: list[dict[str, Any]] | None = None,
    dismissed_themes: list[tuple[str, int]] | None = None,
) -> str:
    """Build the classification prompt for a single message."""
    context_lines = ""
    if context_messages:
        for cm in context_messages[-3:]:
            context_lines += f"  {cm.get('sender_name', '?')}: {cm.get('body', '')}\n"
    if not context_lines:
        context_lines = "  (no recent context)"

    dismissed_block = ""
    if dismissed_themes:
        dismissed_block = "\nDISMISSED THEMES (Braydon finds these less relevant, down-weight):\n"
        for theme, count in dismissed_themes:
            times = "time" if count == 1 else "times"
            dismissed_block += f"  {theme}: dismissed {count} {times}\n"

    return CLASSIFY_TEMPLATE.format(
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        sender_name=message.get("sender_name", "Unknown"),
        room_name=message.get("room_name", "Unknown"),
        body=message.get("body", ""),
        context=context_lines,
    ) + dismissed_block
```

Also add a helper to load dismissed themes from DB:

```python
def load_dismissed_themes(db_path: Path, limit: int = 50) -> list[tuple[str, int]]:
    """Load aggregated dismissed themes from user_feedback."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT theme, COUNT(*) as cnt FROM user_feedback
           WHERE action = 'dismiss'
           GROUP BY theme ORDER BY cnt DESC LIMIT ?""",
        (limit,),
    )
    rows = [(r[0], r[1]) for r in cursor.fetchall()]
    conn.close()
    return rows
```

Update `classify_messages` to load and pass dismissed themes:

```python
async def classify_messages(config: Config, messages: list[dict[str, Any]]) -> None:
    """Classify a batch of messages using Sonnet."""
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    value_cfg = load_value_config(config.db_path)
    dismissed = load_dismissed_themes(config.db_path)

    for msg in messages:
        try:
            context = get_recent_context(config.db_path, msg["room_id"], msg["timestamp"])
            prompt = build_classify_prompt(msg, value_cfg, context, dismissed_themes=dismissed)
            # ... rest unchanged
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_classifier.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/classifier.py backend/tests/test_classifier.py
git commit -m "feat: classifier learns from dismissed themes"
```

---

## Task 6: Synthesis Learns from Dismissals

**Files:**
- Modify: `backend/vibez/synthesis.py:110-150` (build_synthesis_prompt to include dismissals)
- Modify: `backend/vibez/synthesis.py:254-289` (run_daily_synthesis to load dismissals)
- Test: `backend/tests/test_synthesis.py`

**Step 1: Write the failing test**

Add to `backend/tests/test_synthesis.py`:

```python
def test_build_synthesis_prompt_with_dismissed_themes(tmp_db):
    _seed_messages(tmp_db)
    messages = get_day_messages(tmp_db, 1708300000000, 1708300000000 + 300000)
    value_config = {"topics": ["agentic-arch"], "projects": ["Amplifier"]}
    dismissed = [("productivity", 2), ("business-ai", 1)]
    prompt = build_synthesis_prompt(messages, value_config, dismissed_themes=dismissed)
    assert "DEPRIORITIZED THEMES" in prompt
    assert "productivity" in prompt
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_synthesis.py::test_build_synthesis_prompt_with_dismissed_themes -v`
Expected: FAIL

**Step 3: Add dismissed_themes to build_synthesis_prompt**

In `backend/vibez/synthesis.py`, modify `build_synthesis_prompt`:

```python
def build_synthesis_prompt(
    messages: list[dict[str, Any]],
    value_config: dict[str, Any],
    previous_briefing: str | None = None,
    dismissed_themes: list[tuple[str, int]] | None = None,
) -> str:
    """Build the synthesis prompt from classified messages."""
    # ... existing code unchanged until the return ...

    dismissed_block = ""
    if dismissed_themes:
        dismissed_block = "\nDEPRIORITIZED THEMES (Braydon has dismissed these, deprioritize):\n"
        for theme, count in dismissed_themes:
            dismissed_block += f"  {theme} (dismissed {count}x)\n"

    return SYNTHESIS_TEMPLATE.format(
        msg_count=len(messages), group_count=len(groups),
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        previous_context=previous_context, messages_block=messages_block,
        contribution_themes_block=contribution_themes_block,
    ) + dismissed_block
```

Update `run_daily_synthesis` to load and pass dismissed themes:

```python
async def run_daily_synthesis(config: Config) -> dict[str, Any]:
    """Run the daily synthesis for the last 24 hours."""
    from vibez.classifier import load_value_config, load_dismissed_themes

    init_db(config.db_path)

    # ... existing time/date/messages/value_cfg/previous code ...

    dismissed = load_dismissed_themes(config.db_path)
    prompt = build_synthesis_prompt(messages, value_cfg, previous, dismissed_themes=dismissed)

    # ... rest unchanged ...
```

**Step 4: Run tests**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_synthesis.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/synthesis.py backend/tests/test_synthesis.py
git commit -m "feat: synthesis deprioritizes dismissed themes"
```

---

## Task 7: Git Work Context Module

**Files:**
- Create: `backend/vibez/work_context.py`
- Create: `backend/tests/test_work_context.py`
- Modify: `backend/vibez/db.py:61-81` (add `repos` to DEFAULT_VALUE_CONFIG)

**Step 1: Write the failing test**

Create `backend/tests/test_work_context.py`:

```python
import json
from unittest.mock import patch
from vibez.work_context import gather_git_activity, format_work_context_prompt


def test_gather_git_activity_with_mock():
    fake_output = "abc1234 feat: add token refresh\ndef5678 fix: pagination bug"
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = type("Result", (), {
            "stdout": fake_output, "returncode": 0
        })()
        result = gather_git_activity(["/fake/repo/amplifier"])
    assert len(result) == 1
    assert result[0]["repo"] == "amplifier"
    assert "token refresh" in result[0]["log"]


def test_gather_git_activity_skips_missing_repo():
    result = gather_git_activity(["/nonexistent/repo/fakething"])
    assert len(result) == 0


def test_format_work_context_prompt():
    activity = [
        {"repo": "amplifier", "log": "abc1234 feat: add streaming\ndef5678 fix: retry", "diff_stat": "3 files changed"},
        {"repo": "workgraph", "log": "111aaaa refactor: task resolver", "diff_stat": "1 file changed"},
    ]
    prompt = format_work_context_prompt(activity)
    assert "amplifier" in prompt
    assert "workgraph" in prompt
    assert "streaming" in prompt
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_work_context.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'vibez.work_context'`

**Step 3: Implement work_context.py**

Create `backend/vibez/work_context.py`:

```python
"""Git-based work context summarizer for classifier and synthesis enrichment."""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection

logger = logging.getLogger("vibez.work_context")


def gather_git_activity(repo_paths: list[str], since_days: int = 3) -> list[dict[str, str]]:
    """Scan repos for recent git activity. Returns list of {repo, log, diff_stat}."""
    results = []
    for repo_path in repo_paths:
        path = Path(repo_path)
        if not (path / ".git").exists():
            logger.debug("Skipping %s (not a git repo)", repo_path)
            continue
        try:
            log_result = subprocess.run(
                ["git", "log", f"--since={since_days} days ago", "--oneline", "--no-merges"],
                cwd=str(path), capture_output=True, text=True, timeout=10,
            )
            if log_result.returncode != 0 or not log_result.stdout.strip():
                continue
            diff_result = subprocess.run(
                ["git", "diff", "--stat", f"HEAD~5..HEAD"],
                cwd=str(path), capture_output=True, text=True, timeout=10,
            )
            results.append({
                "repo": path.name,
                "log": log_result.stdout.strip(),
                "diff_stat": diff_result.stdout.strip() if diff_result.returncode == 0 else "",
            })
        except (subprocess.TimeoutExpired, OSError):
            logger.warning("Failed to read git activity from %s", repo_path)
    return results


def format_work_context_prompt(activity: list[dict[str, str]]) -> str:
    """Format git activity into a prompt block for classifier/synthesis."""
    if not activity:
        return ""
    lines = ["BRAYDON'S ACTIVE WORK (from git activity, last 3 days):"]
    for repo in activity:
        lines.append(f"\n  {repo['repo']}:")
        for commit_line in repo["log"].split("\n")[:5]:
            lines.append(f"    {commit_line}")
        if repo["diff_stat"]:
            stat_lines = repo["diff_stat"].split("\n")
            if stat_lines:
                lines.append(f"    ({stat_lines[-1].strip()})")
    return "\n".join(lines)


async def summarize_work_context(config: Config, activity: list[dict[str, str]]) -> str:
    """Use Haiku to summarize git activity into a concise work context."""
    if not activity:
        return ""
    raw_context = format_work_context_prompt(activity)
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": f"Summarize what Braydon is actively building and shipping across these repos. "
                       f"Be specific about features, not just file names. 2-3 sentences per repo.\n\n{raw_context}",
        }],
    )
    return response.content[0].text


def save_work_context(db_path: Path, context: str) -> None:
    """Save work context summary to value_config."""
    conn = get_connection(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO value_config (key, value) VALUES (?, ?)",
        ("work_context", json.dumps(context)),
    )
    conn.commit()
    conn.close()


def load_work_context(db_path: Path) -> str:
    """Load stored work context from value_config."""
    conn = get_connection(db_path)
    cursor = conn.execute("SELECT value FROM value_config WHERE key = 'work_context'")
    row = cursor.fetchone()
    conn.close()
    if row:
        return json.loads(row[0])
    return ""
```

Also add `repos` to `DEFAULT_VALUE_CONFIG` in `backend/vibez/db.py`:

```python
DEFAULT_VALUE_CONFIG = {
    "topics": [...],  # unchanged
    "projects": [...],  # unchanged
    "alert_threshold": 7,
    "repos": [
        "/Users/braydon/projects/experiments/amplifier",
        "/Users/braydon/projects/experiments/driftdriver",
        "/Users/braydon/projects/experiments/workgraph",
        "/Users/braydon/projects/experiments/speedrift-ecosystem",
        "/Users/braydon/projects/personal/vibez-monitor",
        "/Users/braydon/projects/personal/moneycommand",
    ],
}
```

Update `test_default_value_config_seeded` in `test_db.py`:

```python
def test_default_value_config_seeded(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cursor = conn.execute("SELECT COUNT(*) FROM value_config")
    assert cursor.fetchone()[0] == 4  # topics, projects, alert_threshold, repos
```

**Step 4: Run tests**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_work_context.py backend/tests/test_db.py -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/work_context.py backend/tests/test_work_context.py backend/vibez/db.py backend/tests/test_db.py
git commit -m "feat: add git work context summarizer"
```

---

## Task 8: Inject Work Context into Classifier and Synthesis

**Files:**
- Modify: `backend/vibez/classifier.py` (add work_context to prompt)
- Modify: `backend/vibez/synthesis.py` (add work_context to prompt)
- Test: `backend/tests/test_classifier.py`, `backend/tests/test_synthesis.py`

**Step 1: Write failing tests**

Add to `backend/tests/test_classifier.py`:

```python
def test_build_classify_prompt_with_work_context():
    message = {
        "sender_name": "Sam",
        "room_name": "The vibez",
        "body": "check out the new streaming feature",
    }
    value_config = {"topics": ["agentic-architecture"], "projects": ["Amplifier"]}
    work_context = "Braydon is building streaming support in Amplifier and task dependency resolution in workgraph."
    prompt = build_classify_prompt(message, value_config, work_context=work_context)
    assert "CURRENT WORK" in prompt
    assert "streaming support in Amplifier" in prompt
```

Add to `backend/tests/test_synthesis.py`:

```python
def test_build_synthesis_prompt_with_work_context(tmp_db):
    _seed_messages(tmp_db)
    messages = get_day_messages(tmp_db, 1708300000000, 1708300000000 + 300000)
    value_config = {"topics": ["agentic-arch"], "projects": ["Amplifier"]}
    work_context = "Building streaming in Amplifier, task resolver in workgraph."
    prompt = build_synthesis_prompt(messages, value_config, work_context=work_context)
    assert "CURRENT WORK" in prompt
    assert "streaming in Amplifier" in prompt
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_classifier.py::test_build_classify_prompt_with_work_context backend/tests/test_synthesis.py::test_build_synthesis_prompt_with_work_context -v`
Expected: FAIL

**Step 3: Add work_context parameter**

In `backend/vibez/classifier.py`, add `work_context` param to `build_classify_prompt`:

```python
def build_classify_prompt(
    message: dict[str, Any],
    value_config: dict[str, Any],
    context_messages: list[dict[str, Any]] | None = None,
    dismissed_themes: list[tuple[str, int]] | None = None,
    work_context: str = "",
) -> str:
    # ... existing code ...

    work_block = ""
    if work_context:
        work_block = f"\nBRAYDON'S CURRENT WORK (from git):\n  {work_context}\n\nUse this to identify specific contribution opportunities where his current work directly relates.\n"

    return CLASSIFY_TEMPLATE.format(...) + dismissed_block + work_block
```

Update `classify_messages` to load and pass work context:

```python
async def classify_messages(config: Config, messages: list[dict[str, Any]]) -> None:
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    value_cfg = load_value_config(config.db_path)
    dismissed = load_dismissed_themes(config.db_path)

    from vibez.work_context import load_work_context
    work_ctx = load_work_context(config.db_path)

    for msg in messages:
        try:
            context = get_recent_context(config.db_path, msg["room_id"], msg["timestamp"])
            prompt = build_classify_prompt(msg, value_cfg, context, dismissed_themes=dismissed, work_context=work_ctx)
            # ... rest unchanged
```

In `backend/vibez/synthesis.py`, add `work_context` param to `build_synthesis_prompt`:

```python
def build_synthesis_prompt(
    messages: list[dict[str, Any]],
    value_config: dict[str, Any],
    previous_briefing: str | None = None,
    dismissed_themes: list[tuple[str, int]] | None = None,
    work_context: str = "",
) -> str:
    # ... existing code ...

    work_block = ""
    if work_context:
        work_block = f"\nBRAYDON'S CURRENT WORK (from git):\n  {work_context}\n\nWhen suggesting contributions, connect them to this active work.\n"

    return SYNTHESIS_TEMPLATE.format(...) + dismissed_block + work_block
```

Update `run_daily_synthesis`:

```python
    from vibez.work_context import load_work_context
    work_ctx = load_work_context(config.db_path)
    prompt = build_synthesis_prompt(messages, value_cfg, previous, dismissed_themes=dismissed, work_context=work_ctx)
```

**Step 4: Run all tests**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/ -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/classifier.py backend/vibez/synthesis.py backend/tests/test_classifier.py backend/tests/test_synthesis.py
git commit -m "feat: inject work context into classifier and synthesis prompts"
```

---

## Task 9: Analyst Module (Question Generation + Research + PoV)

**Files:**
- Create: `backend/vibez/analyst.py`
- Create: `backend/tests/test_analyst.py`
- Modify: `backend/vibez/config.py` (add perplexity_api_key)

**Step 1: Add PERPLEXITY_API_KEY to config**

In `backend/vibez/config.py`, add field to Config:

```python
@dataclass
class Config:
    # ... existing fields ...
    perplexity_api_key: str = ""
```

And in `from_env()`:

```python
    perplexity_api_key=os.environ.get("PERPLEXITY_API_KEY", ""),
```

Add `PERPLEXITY_API_KEY=pplx-xxxxx` to `.env.example` and `.env`.

**Step 2: Write the failing tests**

Create `backend/tests/test_analyst.py`:

```python
import json
from vibez.analyst import (
    build_questions_prompt,
    parse_questions,
    build_pov_prompt,
    parse_pov,
    perplexity_search,
)


def test_build_questions_prompt():
    synthesis = {
        "briefing": [{"title": "Model routing discussion", "insights": "Community converging on tiered approach"}],
        "trends": {"emerging": ["multi-model routing"], "fading": ["single-model"]},
    }
    work_context = "Building task dependency resolver in workgraph"
    prompt = build_questions_prompt(synthesis, work_context)
    assert "Model routing discussion" in prompt
    assert "multi-model routing" in prompt
    assert "workgraph" in prompt


def test_parse_questions_valid():
    raw = json.dumps([
        {
            "question": "Why is nobody discussing eval for routers?",
            "spark": "Thread X and Y both mentioned routing",
            "relevance_to_braydon": "Driftdriver has eval hooks",
        }
    ])
    result = parse_questions(raw)
    assert len(result) == 1
    assert "eval" in result[0]["question"]


def test_parse_questions_invalid():
    result = parse_questions("not json")
    assert result == []


def test_build_pov_prompt():
    questions = [{"question": "Why no eval?", "spark": "gap", "relevance_to_braydon": "driftdriver"}]
    research = [{"question": "Why no eval?", "answer": "Some do exist...", "citations": ["https://example.com"]}]
    work_context = "Building eval in driftdriver"
    prompt = build_pov_prompt(questions, research, work_context)
    assert "Why no eval?" in prompt
    assert "Some do exist" in prompt
    assert "driftdriver" in prompt


def test_parse_pov_valid():
    raw = json.dumps([
        {
            "question": "Why no eval?",
            "research_summary": "There are some eval tools",
            "citations": ["https://example.com"],
            "pov": "Eval is underserved",
            "action": "Share driftdriver eval hooks",
            "confidence": "high",
        }
    ])
    result = parse_pov(raw)
    assert len(result) == 1
    assert result[0]["confidence"] == "high"


def test_parse_pov_invalid():
    result = parse_pov("not json")
    assert result == []
```

**Step 3: Run tests to verify they fail**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_analyst.py -v`
Expected: FAIL — `ModuleNotFoundError`

**Step 4: Implement analyst.py**

Create `backend/vibez/analyst.py`:

```python
"""Autonomous curiosity agent — generates questions, researches, forms PoVs."""

from __future__ import annotations

import json
import logging
import re
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection, init_db

logger = logging.getLogger("vibez.analyst")

QUESTIONS_SYSTEM = """You are an intelligence analyst who spots gaps, contradictions, and unexplored angles.
Always respond with valid JSON only. No prose outside the JSON array."""

QUESTIONS_TEMPLATE = """Today's key threads from the Vibez WhatsApp ecosystem:
{briefing_block}

Emerging trends: {emerging}
Fading trends: {fading}

Braydon's active work: {work_context}

What 3-5 questions does today's conversation make you genuinely curious about?

Look for:
- Gaps: What's nobody talking about that they should be?
- Contradictions: Where do people disagree and who's right?
- Unexplored angles: What's the second-order effect of what's being discussed?
- Connections: What threads connect to each other in ways nobody mentioned?
- Opportunities: What could Braydon build/share that nobody's asked for yet?

Return JSON array:
[
  {{
    "question": "...",
    "spark": "What triggered this question",
    "relevance_to_braydon": "Why this matters to his work"
  }}
]"""

POV_SYSTEM = """You are an opinionated intelligence analyst. Pick sides. Be specific.
Always respond with valid JSON only. No prose outside the JSON array."""

POV_TEMPLATE = """You researched these questions about the AI/agentic ecosystem.
Form a point of view on each. Be opinionated. Be specific.

Braydon's active work: {work_context}

Questions and research:
{research_block}

For each question, return JSON array:
[
  {{
    "question": "...",
    "research_summary": "2-3 sentences of key findings",
    "citations": ["url1", "url2"],
    "pov": "Opinionated 2-3 sentence take",
    "action": "Specific action for Braydon (not 'keep an eye on it')",
    "confidence": "high|medium|low"
  }}
]"""


def build_questions_prompt(synthesis: dict[str, Any], work_context: str) -> str:
    """Build the question generation prompt from synthesis output."""
    briefing = synthesis.get("briefing", [])
    briefing_block = ""
    for thread in briefing:
        briefing_block += f"- {thread.get('title', '')}: {thread.get('insights', '')}\n"
    if not briefing_block:
        briefing_block = "(no threads today)"

    trends = synthesis.get("trends", {})
    emerging = ", ".join(trends.get("emerging", [])) or "(none)"
    fading = ", ".join(trends.get("fading", [])) or "(none)"

    return QUESTIONS_TEMPLATE.format(
        briefing_block=briefing_block,
        emerging=emerging,
        fading=fading,
        work_context=work_context or "(no recent git activity)",
    )


def parse_questions(raw: str) -> list[dict[str, str]]:
    """Parse question generation output."""
    try:
        cleaned = raw.strip()
        cleaned = re.sub(r"<think>.*?</think>", "", cleaned, flags=re.DOTALL).strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        data = json.loads(cleaned.strip())
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, KeyError):
        logger.warning("Failed to parse questions: %s", raw[:200])
    return []


def perplexity_search(api_key: str, query: str, model: str = "sonar-reasoning") -> dict[str, Any]:
    """Call Perplexity API directly. Returns {answer, citations}."""
    if not api_key:
        logger.warning("No Perplexity API key — skipping research for: %s", query[:80])
        return {"question": query, "answer": "(no API key configured)", "citations": []}

    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": query}],
    }).encode()

    req = urllib.request.Request(
        "https://api.perplexity.ai/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        answer = data["choices"][0]["message"]["content"]
        citations = data.get("citations", [])
        return {"question": query, "answer": answer, "citations": citations}
    except Exception:
        logger.exception("Perplexity search failed for: %s", query[:80])
        return {"question": query, "answer": "(research failed)", "citations": []}


def build_pov_prompt(
    questions: list[dict[str, str]],
    research: list[dict[str, Any]],
    work_context: str,
) -> str:
    """Build the PoV synthesis prompt from questions + research."""
    research_block = ""
    for q, r in zip(questions, research):
        research_block += f"\nQ: {q['question']}\n"
        research_block += f"Spark: {q.get('spark', '')}\n"
        research_block += f"Research: {r.get('answer', '(none)')[:2000]}\n"
        if r.get("citations"):
            research_block += f"Sources: {', '.join(r['citations'][:5])}\n"

    return POV_TEMPLATE.format(
        work_context=work_context or "(no recent git activity)",
        research_block=research_block,
    )


def parse_pov(raw: str) -> list[dict[str, Any]]:
    """Parse PoV synthesis output."""
    try:
        cleaned = raw.strip()
        cleaned = re.sub(r"<think>.*?</think>", "", cleaned, flags=re.DOTALL).strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        data = json.loads(cleaned.strip())
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, KeyError):
        logger.warning("Failed to parse PoV: %s", raw[:200])
    return []


def render_analyst_markdown(questions: list[dict], povs: list[dict], report_date: str) -> str:
    """Render analyst report as markdown."""
    lines = [f"# Analyst Report — {report_date}\n"]
    for i, pov in enumerate(povs, 1):
        q = questions[i - 1] if i <= len(questions) else {}
        conf = pov.get("confidence", "medium")
        conf_badge = {"high": "HIGH", "medium": "MED", "low": "LOW"}.get(conf, conf.upper())
        lines.append(f"## {i}. {pov.get('question', q.get('question', 'Unknown'))}")
        lines.append(f"**Confidence:** {conf_badge}")
        if q.get("spark"):
            lines.append(f"\n*Sparked by:* {q['spark']}")
        lines.append(f"\n**Research:** {pov.get('research_summary', '')}")
        if pov.get("citations"):
            for url in pov["citations"][:5]:
                lines.append(f"- {url}")
        lines.append(f"\n**Point of View:** {pov.get('pov', '')}")
        lines.append(f"\n**Action:** {pov.get('action', '')}")
        lines.append("")
    return "\n".join(lines)


def save_analyst_report(
    db_path: Path, report_date: str,
    questions: list, research: list, povs: list, pov_md: str,
) -> None:
    """Save analyst report to database."""
    conn = get_connection(db_path)
    conn.execute(
        """INSERT INTO analyst_reports (report_date, questions_json, research_json, pov_json, pov_md)
           VALUES (?, ?, ?, ?, ?)""",
        (report_date, json.dumps(questions), json.dumps(research), json.dumps(povs), pov_md),
    )
    conn.commit()
    conn.close()


async def run_analyst(config: Config, synthesis_report: dict[str, Any]) -> dict[str, Any]:
    """Run the full analyst pipeline: questions -> research -> PoV."""
    from vibez.work_context import load_work_context

    init_db(config.db_path)
    work_ctx = load_work_context(config.db_path)
    report_date = datetime.now().strftime("%Y-%m-%d")

    # Stage 1: Generate questions
    logger.info("Analyst: generating questions...")
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    q_prompt = build_questions_prompt(synthesis_report, work_ctx)
    q_response = client.messages.create(
        model=config.synthesis_model, max_tokens=2048,
        system=QUESTIONS_SYSTEM,
        messages=[{"role": "user", "content": q_prompt}],
    )
    questions = parse_questions(q_response.content[0].text)
    logger.info("Analyst: %d questions generated", len(questions))

    if not questions:
        return {"questions": [], "research": [], "povs": [], "pov_md": ""}

    # Stage 2: Research via Perplexity
    logger.info("Analyst: researching %d questions via Perplexity...", len(questions))
    research = []
    for q in questions:
        result = perplexity_search(config.perplexity_api_key, q["question"])
        research.append(result)
        logger.info("  Researched: %s", q["question"][:60])

    # Stage 3: Synthesize PoVs
    logger.info("Analyst: synthesizing points of view...")
    pov_prompt = build_pov_prompt(questions, research, work_ctx)
    pov_response = client.messages.create(
        model=config.synthesis_model, max_tokens=4096,
        system=POV_SYSTEM,
        messages=[{"role": "user", "content": pov_prompt}],
    )
    povs = parse_pov(pov_response.content[0].text)
    logger.info("Analyst: %d PoVs formed", len(povs))

    pov_md = render_analyst_markdown(questions, povs, report_date)
    save_analyst_report(config.db_path, report_date, questions, research, povs, pov_md)

    return {"questions": questions, "research": research, "povs": povs, "pov_md": pov_md}
```

**Step 5: Run tests**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python -m pytest backend/tests/test_analyst.py -v`
Expected: ALL PASS

**Step 6: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/vibez/analyst.py backend/tests/test_analyst.py backend/vibez/config.py
git commit -m "feat: add analyst module with question generation, Perplexity research, and PoV synthesis"
```

---

## Task 10: Wire Analyst + Work Context into Daily Pipeline

**Files:**
- Modify: `backend/scripts/run_synthesis.py`

**Step 1: Update run_synthesis.py to run the full pipeline**

Replace `backend/scripts/run_synthesis.py`:

```python
"""Entry point for the daily intelligence pipeline: work context -> synthesis -> analyst."""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.synthesis import run_daily_synthesis


async def main():
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "synthesis.log"),
        ],
    )

    logger = logging.getLogger("vibez.synthesis")

    # Step 1: Refresh work context from git
    logger.info("Refreshing work context from git repos...")
    from vibez.classifier import load_value_config
    from vibez.work_context import gather_git_activity, summarize_work_context, save_work_context

    value_cfg = load_value_config(config.db_path)
    repos = value_cfg.get("repos", [])
    if repos:
        activity = gather_git_activity(repos)
        if activity:
            summary = await summarize_work_context(config, activity)
            save_work_context(config.db_path, summary)
            logger.info("Work context updated: %d repos active", len(activity))
        else:
            logger.info("No recent git activity found")
    else:
        logger.info("No repos configured, skipping work context")

    # Step 2: Run daily synthesis
    logger.info("Running daily synthesis...")
    report = await run_daily_synthesis(config)
    logger.info("Synthesis done. Briefing threads: %d", len(report.get("briefing", [])))

    # Step 3: Run analyst (curiosity agent)
    if report.get("briefing"):
        logger.info("Running analyst...")
        from vibez.analyst import run_analyst
        analyst_report = await run_analyst(config, report)
        logger.info(
            "Analyst done. Questions: %d, PoVs: %d",
            len(analyst_report.get("questions", [])),
            len(analyst_report.get("povs", [])),
        )
    else:
        logger.info("No briefing data — skipping analyst")


if __name__ == "__main__":
    asyncio.run(main())
```

**Step 2: Verify the pipeline runs**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && backend/.venv/bin/python backend/scripts/run_synthesis.py 2>&1 | head -20`
Expected: Logs showing work context refresh, synthesis, and analyst steps

**Step 3: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add backend/scripts/run_synthesis.py
git commit -m "feat: wire work context + analyst into daily synthesis pipeline"
```

---

## Task 11: Analyst Dashboard Page

**Files:**
- Create: `dashboard/src/app/analyst/page.tsx`
- Create: `dashboard/src/app/api/analyst/route.ts`
- Modify: `dashboard/src/lib/db.ts` (add analyst query)

**Step 1: Add analyst query to db.ts**

Add to `dashboard/src/lib/db.ts`:

```typescript
export interface AnalystReport {
  id: number;
  report_date: string;
  questions_json: string;
  research_json: string;
  pov_json: string;
  pov_md: string;
  generated_at: string;
}

export function getLatestAnalystReport(): AnalystReport | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM analyst_reports ORDER BY report_date DESC LIMIT 1")
    .get() as AnalystReport | undefined;
  db.close();
  return row || null;
}
```

**Step 2: Create analyst API route**

Create `dashboard/src/app/api/analyst/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getLatestAnalystReport } from "@/lib/db";

export async function GET() {
  try {
    const report = getLatestAnalystReport();
    return NextResponse.json({ report });
  } catch {
    return NextResponse.json({ report: null });
  }
}
```

**Step 3: Create analyst page**

Create `dashboard/src/app/analyst/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

interface PoV {
  question: string;
  research_summary: string;
  citations: string[];
  pov: string;
  action: string;
  confidence: string;
}

interface Question {
  question: string;
  spark: string;
  relevance_to_braydon: string;
}

export default function AnalystPage() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [povs, setPoVs] = useState<PoV[]>([]);
  const [reportDate, setReportDate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/analyst")
      .then((r) => r.json())
      .then((data) => {
        if (data.report) {
          setQuestions(JSON.parse(data.report.questions_json || "[]"));
          setPoVs(JSON.parse(data.report.pov_json || "[]"));
          setReportDate(data.report.report_date);
        }
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="text-zinc-500">Loading...</div>;
  if (!reportDate) return <div className="text-zinc-500">No analyst reports yet. Run the daily pipeline to generate one.</div>;

  const confColor = (c: string) => {
    if (c === "high") return "bg-emerald-900 text-emerald-300";
    if (c === "medium") return "bg-amber-900 text-amber-300";
    return "bg-zinc-700 text-zinc-400";
  };

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold">Analyst</h1>
      <p className="mb-6 text-sm text-zinc-500">Questions the agent found curious + researched PoVs — {reportDate}</p>

      <div className="flex flex-col gap-4">
        {povs.map((pov, i) => {
          const q = questions[i];
          const isExpanded = expanded === i;
          return (
            <div key={i} className="rounded-lg border border-violet-900 bg-zinc-900">
              <button
                onClick={() => setExpanded(isExpanded ? null : i)}
                className="flex w-full items-start justify-between p-4 text-left"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${confColor(pov.confidence)}`}>
                      {pov.confidence}
                    </span>
                  </div>
                  <h3 className="font-medium text-zinc-200">{pov.question}</h3>
                  {q?.spark && (
                    <p className="mt-1 text-xs text-zinc-500">Sparked by: {q.spark}</p>
                  )}
                </div>
                <span className="ml-2 text-zinc-500">{isExpanded ? "\u2212" : "+"}</span>
              </button>

              {isExpanded && (
                <div className="border-t border-zinc-800 p-4 space-y-4">
                  {q?.relevance_to_braydon && (
                    <div className="text-sm text-zinc-400">
                      <span className="font-medium text-zinc-300">Relevance: </span>
                      {q.relevance_to_braydon}
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-zinc-300 mb-1">Research</h4>
                    <p className="text-sm text-zinc-400">{pov.research_summary}</p>
                    {pov.citations?.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {pov.citations.slice(0, 5).map((url, j) => (
                          <a key={j} href={url} target="_blank" rel="noopener noreferrer"
                             className="text-xs text-blue-400 hover:underline truncate">{url}</a>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded border border-violet-800 bg-violet-950/30 p-3">
                    <h4 className="text-sm font-medium text-violet-300 mb-1">Point of View</h4>
                    <p className="text-sm text-zinc-200">{pov.pov}</p>
                  </div>

                  <div className="rounded border border-emerald-800 bg-emerald-950/30 p-3">
                    <h4 className="text-sm font-medium text-emerald-300 mb-1">Suggested Action</h4>
                    <p className="text-sm text-zinc-200">{pov.action}</p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 4: Build and verify**

Run: `cd /Users/braydon/projects/personal/vibez-monitor/dashboard && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/app/analyst/page.tsx dashboard/src/app/api/analyst/route.ts dashboard/src/lib/db.ts
git commit -m "feat: add analyst dashboard page with question/research/PoV display"
```

---

## Task 12: Settings Page — Repos + Dismissed Themes

**Files:**
- Modify: `dashboard/src/app/settings/page.tsx`

**Step 1: Expand settings page**

Replace `dashboard/src/app/settings/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topicsInput, setTopicsInput] = useState("");
  const [projectsInput, setProjectsInput] = useState("");
  const [reposInput, setReposInput] = useState("");
  const [threshold, setThreshold] = useState(7);
  const [dismissedThemes, setDismissedThemes] = useState<{ theme: string; count: number }[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/feedback?dismissed=themes").then((r) => r.json()),
    ]).then(([settingsData, feedbackData]) => {
      setTopicsInput((settingsData.config.topics as string[] || []).join(", "));
      setProjectsInput((settingsData.config.projects as string[] || []).join(", "));
      setReposInput((settingsData.config.repos as string[] || []).join("\n"));
      setThreshold((settingsData.config.alert_threshold as number) || 7);
      setDismissedThemes(feedbackData.themes || []);
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const topics = topicsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const projects = projectsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const repos = reposInput.split("\n").map((t) => t.trim()).filter(Boolean);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics, projects, repos, alert_threshold: threshold }),
    });
    setSaving(false);
  };

  const undismiss = async (theme: string) => {
    const feedback = await fetch(`/api/feedback?action=dismiss`).then((r) => r.json());
    const items = (feedback.feedback || []).filter((f: { theme: string }) => f.theme === theme);
    for (const item of items) {
      await fetch(`/api/feedback?id=${item.id}`, { method: "DELETE" });
    }
    setDismissedThemes((prev) => prev.filter((t) => t.theme !== theme));
  };

  if (loading) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Interest Topics</label>
          <textarea className="w-full rounded bg-zinc-800 p-3 text-sm text-zinc-200" rows={3}
            value={topicsInput} onChange={(e) => setTopicsInput(e.target.value)}
            placeholder="agentic-architecture, practical-tools, business-ai" />
          <p className="mt-1 text-xs text-zinc-500">Comma-separated topic tags</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Your Projects</label>
          <textarea className="w-full rounded bg-zinc-800 p-3 text-sm text-zinc-200" rows={2}
            value={projectsInput} onChange={(e) => setProjectsInput(e.target.value)}
            placeholder="MoneyCommand, Amplifier, driftdriver" />
          <p className="mt-1 text-xs text-zinc-500">Comma-separated project names the classifier matches against</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Git Repos (for work context)</label>
          <textarea className="w-full rounded bg-zinc-800 p-3 text-sm font-mono text-zinc-200" rows={4}
            value={reposInput} onChange={(e) => setReposInput(e.target.value)}
            placeholder="/Users/braydon/projects/experiments/amplifier&#10;/Users/braydon/projects/experiments/workgraph" />
          <p className="mt-1 text-xs text-zinc-500">One repo path per line. Used by the git work context summarizer.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Hot Alert Threshold</label>
          <input type="range" min={1} max={10} value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value))} className="w-full" />
          <p className="mt-1 text-xs text-zinc-500">Relevance score {threshold}+ triggers hot alerts</p>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="rounded bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50">
          {saving ? "Saving..." : "Save Settings"}
        </button>

        {dismissedThemes.length > 0 && (
          <div>
            <h2 className="mb-3 text-lg font-medium text-zinc-300">Dismissed Themes</h2>
            <p className="mb-2 text-xs text-zinc-500">Themes you've dismissed. The classifier down-weights these.</p>
            <div className="flex flex-wrap gap-2">
              {dismissedThemes.map((t) => (
                <span key={t.theme} className="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-400">
                  {t.theme} ({t.count}x)
                  <button onClick={() => undismiss(t.theme)}
                    className="text-zinc-600 hover:text-red-400" title="Un-dismiss">
                    x
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Build and verify**

Run: `cd /Users/braydon/projects/personal/vibez-monitor/dashboard && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add dashboard/src/app/settings/page.tsx
git commit -m "feat: add repos config and dismissed themes management to settings"
```

---

## Task 13: Run Full Pipeline End-to-End

**Step 1: Add PERPLEXITY_API_KEY to .env**

```bash
# Get a key from https://www.perplexity.ai/ if needed
echo "PERPLEXITY_API_KEY=pplx-your-key-here" >> /Users/braydon/projects/personal/vibez-monitor/.env
```

**Step 2: Run the migration on the live database**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
backend/.venv/bin/python -c "from vibez.db import init_db; init_db('vibez.db')"
```

Expected: No errors. New tables created.

**Step 3: Run the full daily pipeline**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
backend/.venv/bin/python backend/scripts/run_synthesis.py 2>&1
```

Expected: Logs showing:
1. Work context refresh from git repos
2. Daily synthesis complete
3. Analyst questions generated
4. Perplexity research for each question
5. PoVs synthesized
6. Report saved

**Step 4: Verify dashboard**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/dashboard
npm run dev
```

Then visit:
- `http://localhost:3000/contribute` — should show dismiss/bookmark buttons
- `http://localhost:3000/queue` — should show bookmark queue (empty initially)
- `http://localhost:3000/analyst` — should show analyst report with questions + PoVs
- `http://localhost:3000/settings` — should show repos field and dismissed themes section

**Step 5: Run all backend tests**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
backend/.venv/bin/python -m pytest backend/tests/ -v
```

Expected: ALL PASS

**Step 6: Final commit**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git add -A
git commit -m "feat: complete adaptive intelligence layer — dismiss/learn, bookmarks, git context, analyst agent"
```
