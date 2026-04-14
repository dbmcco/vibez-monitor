# Local Analysis + Railway Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local machine the only background analysis worker, replicate derived analysis tables to Railway, and remove all Railway background inference.

**Architecture:** Extend the existing local push pipeline so it sends portable derived-table payloads to Railway using natural keys instead of local integer IDs. Move Railway ingest into a pure helper that can be unit tested, then reduce Railway startup to serving-only so `/api/links`, `/api/wisdom`, and `/api/briefing` read only replicated state.

**Tech Stack:** Python 3.12, SQLite/WAL, Next.js 16, TypeScript, better-sqlite3, bash, Workgraph/Driftdriver.

---

### Task 1: Add Portable Derived-Table Payloads To The Local Push Client

**Files:**
- Create: `backend/tests/test_push_remote.py`
- Modify: `backend/scripts/push_remote.py`
- Reference: `backend/vibez/db.py`
- Test: `backend/tests/test_push_remote.py`

- [ ] **Step 1: Write the failing tests for portable payload extraction**

```python
import json
import sqlite3
from pathlib import Path

from vibez.db import init_db
from backend.scripts.push_remote import (
    DEFAULT_ANALYSIS_SYNC_STATE_KEYS,
    fetch_daily_reports,
    fetch_links,
    fetch_sync_state,
    fetch_wisdom_items,
    fetch_wisdom_recommendations,
    fetch_wisdom_topics,
)


def _seed_analysis_tables(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """INSERT INTO links
           (url, url_hash, title, category, relevance, shared_by, source_group, first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "https://example.com/a",
            "hash-a",
            "Example A",
            "repo",
            "Useful repo",
            "Alice",
            "Show and Tell",
            "2026-04-14T10:00:00+00:00",
            "2026-04-14T10:05:00+00:00",
            2,
            1.5,
            "2026-04-14",
            "Alice",
            1,
        ),
    )
    conn.execute(
        """INSERT INTO daily_reports
           (report_date, briefing_md, briefing_json, contributions, trends, daily_memo, conversation_arcs, stats)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "2026-04-14",
            "# Briefing",
            json.dumps([{"title": "T1"}]),
            "[]",
            "{}",
            "memo",
            "[]",
            "{}",
        ),
    )
    conn.execute(
        """INSERT INTO wisdom_topics
           (name, slug, summary, message_count, contributor_count, last_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "Agent Reviews",
            "agent-reviews",
            "Review loops matter",
            3,
            2,
            "2026-04-14T10:00:00+00:00",
            "2026-04-14T10:00:00+00:00",
            "2026-04-14T10:05:00+00:00",
        ),
    )
    topic_id = conn.execute(
        "SELECT id FROM wisdom_topics WHERE slug = ?",
        ("agent-reviews",),
    ).fetchone()[0]
    conn.execute(
        """INSERT INTO wisdom_items
           (topic_id, knowledge_type, title, summary, source_links, source_messages, contributors, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            topic_id,
            "best_practices",
            "Review loops catch regressions",
            "Use multiple review passes.",
            json.dumps(["https://example.com/a"]),
            json.dumps(["m1"]),
            json.dumps(["Alice"]),
            0.8,
            "2026-04-14T10:00:00+00:00",
            "2026-04-14T10:05:00+00:00",
        ),
    )
    conn.execute(
        """INSERT INTO wisdom_recommendations
           (from_topic_id, to_topic_id, strength, reason)
           VALUES (?, ?, ?, ?)""",
        (topic_id, topic_id, 0.5, "Shared contributors: Alice"),
    )
    conn.executemany(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        [
            ("beeper_active_group_ids", json.dumps(["room-1"])),
            ("beeper_active_group_names", json.dumps(["Show and Tell"])),
            ("google_groups_active_group_keys", json.dumps(["made-of-meat"])),
            ("wisdom_last_run", "1776160800000"),
            ("links_last_refresh_ts", "1776160800000"),
            ("google_groups_uid_cursor:INBOX", "12345"),
        ],
    )
    conn.commit()
    conn.close()


def test_fetch_analysis_tables_return_portable_keys(tmp_path: Path):
    db_path = tmp_path / "vibez.db"
    init_db(db_path)
    _seed_analysis_tables(db_path)

    assert fetch_links(db_path) == [
        {
            "url": "https://example.com/a",
            "url_hash": "hash-a",
            "title": "Example A",
            "category": "repo",
            "relevance": "Useful repo",
            "shared_by": "Alice",
            "source_group": "Show and Tell",
            "first_seen": "2026-04-14T10:00:00+00:00",
            "last_seen": "2026-04-14T10:05:00+00:00",
            "mention_count": 2,
            "value_score": 1.5,
            "report_date": "2026-04-14",
            "authored_by": "Alice",
            "pinned": 1,
        }
    ]
    assert fetch_daily_reports(db_path)[0]["report_date"] == "2026-04-14"
    assert fetch_wisdom_topics(db_path)[0]["slug"] == "agent-reviews"
    assert fetch_wisdom_items(db_path)[0]["topic_slug"] == "agent-reviews"
    assert fetch_wisdom_recommendations(db_path) == [
        {
            "from_topic_slug": "agent-reviews",
            "to_topic_slug": "agent-reviews",
            "strength": 0.5,
            "reason": "Shared contributors: Alice",
        }
    ]


def test_fetch_sync_state_includes_analysis_watermarks_but_not_local_cursors(tmp_path: Path):
    db_path = tmp_path / "vibez.db"
    init_db(db_path)
    _seed_analysis_tables(db_path)

    sync_state = fetch_sync_state(db_path, {"Show and Tell"}, set())

    assert set(sync_state) == set(DEFAULT_ANALYSIS_SYNC_STATE_KEYS)
    assert sync_state["wisdom_last_run"] == "1776160800000"
    assert sync_state["links_last_refresh_ts"] == "1776160800000"
    assert "google_groups_uid_cursor:INBOX" not in sync_state


def test_analysis_sync_state_key_set_stays_transport_safe():
    assert DEFAULT_ANALYSIS_SYNC_STATE_KEYS == (
        "beeper_active_group_ids",
        "beeper_active_group_names",
        "google_groups_active_group_keys",
        "wisdom_last_run",
        "links_last_refresh_ts",
    )
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_push_remote.py -q
```

Expected: FAIL with import errors or assertion failures because the derived-table helpers and expanded sync-state key set do not exist yet.

- [ ] **Step 3: Implement the portable fetch helpers in `backend/scripts/push_remote.py`**

```python
DEFAULT_ANALYSIS_SYNC_STATE_KEYS = (
    "beeper_active_group_ids",
    "beeper_active_group_names",
    "google_groups_active_group_keys",
    "wisdom_last_run",
    "links_last_refresh_ts",
)


def fetch_links(db_path: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT url, url_hash, title, category, relevance, shared_by, source_group,
                  first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned
           FROM links
           ORDER BY last_seen ASC, url_hash ASC"""
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def fetch_daily_reports(db_path: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT report_date, briefing_md, briefing_json, contributions, trends,
                  daily_memo, conversation_arcs, stats, generated_at
           FROM daily_reports
           ORDER BY report_date ASC"""
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def fetch_wisdom_topics(db_path: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT name, slug, summary, message_count, contributor_count,
                  last_active, created_at, updated_at
           FROM wisdom_topics
           ORDER BY slug ASC"""
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def fetch_wisdom_items(db_path: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT wt.slug AS topic_slug, wi.knowledge_type, wi.title, wi.summary,
                  wi.source_links, wi.source_messages, wi.contributors, wi.confidence,
                  wi.created_at, wi.updated_at
           FROM wisdom_items wi
           JOIN wisdom_topics wt ON wt.id = wi.topic_id
           ORDER BY wt.slug ASC, lower(wi.title) ASC"""
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def fetch_wisdom_recommendations(db_path: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT source.slug AS from_topic_slug, target.slug AS to_topic_slug,
                  wr.strength, wr.reason
           FROM wisdom_recommendations wr
           JOIN wisdom_topics source ON source.id = wr.from_topic_id
           JOIN wisdom_topics target ON target.id = wr.to_topic_id
           ORDER BY source.slug ASC, target.slug ASC"""
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]
```

Also update `fetch_sync_state()` so it only reads from `DEFAULT_ANALYSIS_SYNC_STATE_KEYS`. Keep the room-allowlist filtering on `beeper_active_group_names`, `beeper_active_group_ids`, and `google_groups_active_group_keys`, but do not push local cursors such as `google_groups_uid_cursor:*`.

- [ ] **Step 4: Extend the push flow so raw rows and derived tables travel in separate sections**

```python
def push_section(
    remote_url: str,
    push_key: str,
    access_cookie: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    endpoint = urllib.parse.urljoin(remote_url.rstrip("/") + "/", "api/admin/push")
    result, _ = request_json(
        "POST",
        endpoint,
        payload,
        headers={
            "x-vibez-push-key": push_key,
            "Cookie": access_cookie,
        },
    )
    if not result.get("ok"):
        raise RuntimeError(f"Remote push rejected payload: {result}")
    return result


def push_analysis_tables(
    remote_url: str,
    push_key: str,
    access_cookie: str,
    db_path: Path,
    sync_state: dict[str, str],
    batch_size: int,
) -> None:
    for start in range(0, len(fetch_links(db_path)), batch_size):
        push_section(
            remote_url,
            push_key,
            access_cookie,
            {"links": fetch_links(db_path)[start : start + batch_size]},
        )
    for start in range(0, len(fetch_daily_reports(db_path)), batch_size):
        push_section(
            remote_url,
            push_key,
            access_cookie,
            {"daily_reports": fetch_daily_reports(db_path)[start : start + batch_size]},
        )
    for start in range(0, len(fetch_wisdom_topics(db_path)), batch_size):
        push_section(
            remote_url,
            push_key,
            access_cookie,
            {"wisdom_topics": fetch_wisdom_topics(db_path)[start : start + batch_size]},
        )
    for start in range(0, len(fetch_wisdom_items(db_path)), batch_size):
        push_section(
            remote_url,
            push_key,
            access_cookie,
            {"wisdom_items": fetch_wisdom_items(db_path)[start : start + batch_size]},
        )
    for start in range(0, len(fetch_wisdom_recommendations(db_path)), batch_size):
        push_section(
            remote_url,
            push_key,
            access_cookie,
            {
                "wisdom_recommendations": fetch_wisdom_recommendations(db_path)[
                    start : start + batch_size
                ]
            },
        )
    if sync_state:
        push_section(remote_url, push_key, access_cookie, {"sync_state": sync_state})
```

Keep the existing message and classification batching. Push derived tables after the raw message push completes so Railway always has the prerequisite message rows first.

- [ ] **Step 5: Run the focused backend tests and verify GREEN**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_push_remote.py backend/tests/test_links_refresh.py backend/tests/test_wisdom.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/push_remote.py backend/tests/test_push_remote.py
git commit -m "feat: push derived analysis tables to railway"
```

### Task 2: Make The Railway Push Route Ingest Derived Tables By Natural Key

**Files:**
- Create: `dashboard/src/lib/push-ingest.ts`
- Create: `dashboard/src/lib/push-ingest.test.ts`
- Modify: `dashboard/src/app/api/admin/push/route.ts`
- Modify: `dashboard/package.json`
- Modify: `dashboard/package-lock.json`
- Test: `dashboard/src/lib/push-ingest.test.ts`

- [ ] **Step 1: Write the failing ingest helper tests**

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { applyPushPayload } from "@/lib/push-ingest";

const openDbs: Database.Database[] = [];

function openPushTestDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-ingest-"));
  const db = new Database(path.join(dir, "vibez.db"));
  db.exec(`
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      category TEXT,
      relevance TEXT,
      shared_by TEXT,
      source_group TEXT,
      first_seen TEXT,
      last_seen TEXT,
      mention_count INTEGER DEFAULT 1,
      value_score REAL DEFAULT 0,
      report_date TEXT,
      authored_by TEXT,
      pinned INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_links_url_hash ON links (url_hash);
    CREATE VIRTUAL TABLE links_fts USING fts5(title, relevance, category, url);
    CREATE TABLE daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT UNIQUE NOT NULL,
      briefing_md TEXT,
      briefing_json TEXT,
      contributions TEXT,
      trends TEXT,
      daily_memo TEXT,
      conversation_arcs TEXT,
      stats TEXT,
      generated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE wisdom_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      summary TEXT,
      message_count INTEGER DEFAULT 0,
      contributor_count INTEGER DEFAULT 0,
      last_active TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE wisdom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
      knowledge_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      source_links TEXT DEFAULT '[]',
      source_messages TEXT DEFAULT '[]',
      contributors TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.5,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE wisdom_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
      to_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
      strength REAL DEFAULT 0,
      reason TEXT
    );
  `);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("applyPushPayload", () => {
  test("upserts links by url_hash and syncs links_fts", () => {
    const db = openPushTestDb();

    applyPushPayload(db, {
      links: [
        {
          url: "https://example.com/a",
          url_hash: "hash-a",
          title: "Example A",
          category: "repo",
          relevance: "Useful repo",
          shared_by: "Alice",
          source_group: "Show and Tell",
          first_seen: "2026-04-14T10:00:00+00:00",
          last_seen: "2026-04-14T10:05:00+00:00",
          mention_count: 2,
          value_score: 1.5,
          report_date: "2026-04-14",
          authored_by: "Alice",
          pinned: 1,
        },
      ],
    });

    const row = db.prepare(
      "SELECT url, title, mention_count FROM links WHERE url_hash = ?"
    ).get("hash-a");
    const ftsRow = db.prepare(
      "SELECT url FROM links_fts WHERE rowid = (SELECT id FROM links WHERE url_hash = ?)"
    ).get("hash-a");

    expect(row).toMatchObject({
      url: "https://example.com/a",
      title: "Example A",
      mention_count: 2,
    });
    expect(ftsRow).toMatchObject({ url: "https://example.com/a" });
  });

  test("upserts wisdom rows by topic slug rather than local ids", () => {
    const db = openPushTestDb();

    applyPushPayload(db, {
      wisdom_topics: [
        {
          name: "Agent Reviews",
          slug: "agent-reviews",
          summary: "Review loops matter",
          message_count: 3,
          contributor_count: 2,
          last_active: "2026-04-14T10:00:00+00:00",
          created_at: "2026-04-14T10:00:00+00:00",
          updated_at: "2026-04-14T10:05:00+00:00",
        },
      ],
      wisdom_items: [
        {
          topic_slug: "agent-reviews",
          knowledge_type: "best_practices",
          title: "Review loops catch regressions",
          summary: "Use multiple review passes.",
          source_links: "[\"https://example.com/a\"]",
          source_messages: "[\"m1\"]",
          contributors: "[\"Alice\"]",
          confidence: 0.8,
          created_at: "2026-04-14T10:00:00+00:00",
          updated_at: "2026-04-14T10:05:00+00:00",
        },
      ],
      wisdom_recommendations: [
        {
          from_topic_slug: "agent-reviews",
          to_topic_slug: "agent-reviews",
          strength: 0.5,
          reason: "Shared contributors: Alice",
        },
      ],
    });

    const item = db.prepare(
      `SELECT wi.title, wt.slug AS topic_slug
       FROM wisdom_items wi
       JOIN wisdom_topics wt ON wt.id = wi.topic_id`
    ).get();
    const rec = db.prepare(
      `SELECT source.slug AS from_slug, target.slug AS to_slug, wr.strength
       FROM wisdom_recommendations wr
       JOIN wisdom_topics source ON source.id = wr.from_topic_id
       JOIN wisdom_topics target ON target.id = wr.to_topic_id`
    ).get();

    expect(item).toMatchObject({
      title: "Review loops catch regressions",
      topic_slug: "agent-reviews",
    });
    expect(rec).toMatchObject({
      from_slug: "agent-reviews",
      to_slug: "agent-reviews",
      strength: 0.5,
    });
  });
});
```

- [ ] **Step 2: Add a tiny TypeScript unit-test runner and verify RED**

Add to `dashboard/package.json`:

```json
{
  "scripts": {
    "test:unit": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.2.4"
  }
}
```

Run:

```bash
cd dashboard && npm install && npm run test:unit -- src/lib/push-ingest.test.ts
```

Expected: FAIL because `applyPushPayload()` and `dashboard/src/lib/push-ingest.ts` do not exist yet.

- [ ] **Step 3: Implement the pure ingest helper module**

```typescript
import Database from "better-sqlite3";

const ALLOWED_SYNC_STATE_KEYS = new Set([
  "beeper_active_group_ids",
  "beeper_active_group_names",
  "google_groups_active_group_keys",
  "wisdom_last_run",
  "links_last_refresh_ts",
]);

export interface PushPayload {
  records?: RecordPayload[];
  links?: LinkPayload[];
  daily_reports?: DailyReportPayload[];
  wisdom_topics?: WisdomTopicPayload[];
  wisdom_items?: WisdomItemPayload[];
  wisdom_recommendations?: WisdomRecommendationPayload[];
  sync_state?: Record<string, unknown>;
}

export interface PushResult {
  messages_written: number;
  classifications_written: number;
  links_written: number;
  daily_reports_written: number;
  wisdom_topics_written: number;
  wisdom_items_written: number;
  wisdom_recommendations_written: number;
  sync_state_written: number;
}

export function applyPushPayload(
  db: Database.Database,
  payload: PushPayload,
): PushResult {
  const result: PushResult = {
    messages_written: 0,
    classifications_written: 0,
    links_written: 0,
    daily_reports_written: 0,
    wisdom_topics_written: 0,
    wisdom_items_written: 0,
    wisdom_recommendations_written: 0,
    sync_state_written: 0,
  };

  const tx = db.transaction(() => {
    for (const link of payload.links ?? []) {
      upsertLink(db, link);
      syncLinkFtsByUrlHash(db, link.url_hash);
      result.links_written += 1;
    }
    for (const report of payload.daily_reports ?? []) {
      upsertDailyReport(db, report);
      result.daily_reports_written += 1;
    }
    for (const topic of payload.wisdom_topics ?? []) {
      upsertWisdomTopic(db, topic);
      result.wisdom_topics_written += 1;
    }
    for (const item of payload.wisdom_items ?? []) {
      upsertWisdomItem(db, item);
      result.wisdom_items_written += 1;
    }
    for (const recommendation of payload.wisdom_recommendations ?? []) {
      upsertWisdomRecommendation(db, recommendation);
      result.wisdom_recommendations_written += 1;
    }
    for (const [key, value] of Object.entries(payload.sync_state ?? {})) {
      if (!ALLOWED_SYNC_STATE_KEYS.has(key)) continue;
      db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)")
        .run(key, typeof value === "string" ? value : JSON.stringify(value ?? null));
      result.sync_state_written += 1;
    }
  });

  tx();
  return result;
}
```

Implement the remaining helpers with these natural keys:
- links: `url_hash`
- daily reports: `report_date`
- wisdom topics: `slug`
- wisdom items: `(topic_id, lower(title))` after resolving `topic_id` from `topic_slug`
- wisdom recommendations: `(from_topic_id, to_topic_id)` after resolving both topic slugs

`syncLinkFtsByUrlHash()` must delete and reinsert the matching FTS row so `/api/chat` search quality remains intact after remote upserts.

- [ ] **Step 4: Make the route a thin wrapper**

```typescript
const payload = (await request.json()) as PushPayload;
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

try {
  const result = applyPushPayload(db, payload);
  return NextResponse.json({
    ok: true,
    messages_written: result.messages_written,
    classifications_written: result.classifications_written,
    links_written: result.links_written,
    daily_reports_written: result.daily_reports_written,
    wisdom_topics_written: result.wisdom_topics_written,
    wisdom_items_written: result.wisdom_items_written,
    wisdom_recommendations_written: result.wisdom_recommendations_written,
    sync_state_written: result.sync_state_written,
  });
} catch (error) {
  console.error("POST /api/admin/push failed", error);
  return NextResponse.json(
    { ok: false, error: "Failed to write payload." },
    { status: 500 },
  );
} finally {
  db.close();
}
```

Relax validation so the route accepts any non-empty combination of:
- `records`
- `links`
- `daily_reports`
- `wisdom_topics`
- `wisdom_items`
- `wisdom_recommendations`
- `sync_state`

- [ ] **Step 5: Run the helper tests and the dashboard build**

Run:

```bash
cd dashboard && npm run test:unit -- src/lib/push-ingest.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/src/lib/push-ingest.ts dashboard/src/lib/push-ingest.test.ts dashboard/src/app/api/admin/push/route.ts
git commit -m "feat: ingest derived analysis payloads on railway"
```

### Task 3: Remove Railway Background Inference And Localize The Refresh Contract

**Files:**
- Create: `backend/tests/test_runtime_contracts.py`
- Modify: `scripts/railway-start.sh`
- Modify: `scripts/local_sync_to_railway.sh`
- Modify: `README.md`
- Test: `backend/tests/test_runtime_contracts.py`

- [ ] **Step 1: Write the failing runtime-contract tests**

```python
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_railway_start_is_serving_only():
    script = (ROOT / "scripts" / "railway-start.sh").read_text()

    assert "run_sync_once.py" not in script
    assert "refresh_message_links.py" not in script
    assert "enrich_link_authors.py" not in script
    assert "run_wisdom.py" not in script
    assert "run_synthesis.py" not in script


def test_local_sync_script_does_not_trigger_remote_analysis():
    script = (ROOT / "scripts" / "local_sync_to_railway.sh").read_text()

    assert "--skip-remote-refresh" not in script
    assert "RUN_REMOTE_REFRESH" not in script
    assert "railway ssh" not in script
    assert "Local -> Railway sync complete." in script
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_runtime_contracts.py -q
```

Expected: FAIL because both scripts still contain remote/background inference behavior.

- [ ] **Step 3: Replace the Railway and local sync scripts with the local-only contract**

Update `scripts/railway-start.sh` to serving-only startup:

```bash
#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${VIBEZ_DB_PATH:-/data/vibez.db}"

python3 - <<PY
from pathlib import Path
from vibez.db import init_db
init_db(Path("${DB_PATH}"))
print("Initialized sqlite database at ${DB_PATH}")
PY

cd dashboard
exec npx next start --port "${PORT:-3000}" --hostname 0.0.0.0
```

Update `scripts/local_sync_to_railway.sh` so it no longer triggers any Railway SSH refresh:

```bash
echo "Pushing local data to Railway (lookback=${LOOKBACK_DAYS}d)."
"$PYTHON_BIN" backend/scripts/push_remote.py \
  --lookback-days "$LOOKBACK_DAYS" \
  --batch-size "${VIBEZ_PUSH_BATCH_SIZE:-400}"

echo "Local -> Railway sync complete."
```

Also remove:
- `RUN_REMOTE_REFRESH`
- `--skip-remote-refresh`
- every `railway ssh` invocation
- usage text that mentions remote refresh

Update `README.md` so it explicitly states:
- Railway runs zero background inference
- the local machine owns sync, links, wisdom, synthesis, and classifications
- `local_sync_to_railway.sh` replicates already-computed derived state

- [ ] **Step 4: Run the focused verification and verify GREEN**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/test_runtime_contracts.py backend/tests/test_push_remote.py -q
bash -n scripts/local_sync_to_railway.sh scripts/railway-start.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_runtime_contracts.py scripts/railway-start.sh scripts/local_sync_to_railway.sh README.md
git commit -m "fix: make railway serve local analysis only"
```

### Task 4: Verify The Local-Only Analysis Architecture End-To-End

**Files:**
- Modify: none required unless verification finds a bug
- Validate: local SQLite state
- Validate: Railway API state

- [ ] **Step 1: Refresh local derived state before the push**

Run:

```bash
backend/.venv/bin/python backend/scripts/refresh_message_links.py --db vibez.db
backend/.venv/bin/python backend/scripts/enrich_link_authors.py --limit 200
backend/.venv/bin/python backend/scripts/run_wisdom.py vibez.db
backend/.venv/bin/python backend/scripts/run_synthesis.py
```

Expected: local `links`, `wisdom_*`, and `daily_reports` are current before replication.

- [ ] **Step 2: Push the local raw and derived state to Railway**

Run:

```bash
./scripts/local_sync_to_railway.sh --push-only --lookback-days 7
```

Expected: raw message batches finish first, then derived-table sections for links, reports, wisdom topics, wisdom items, wisdom recommendations, and sync state complete without any Railway SSH step.

- [ ] **Step 3: Verify Railway is only serving replicated state**

Run:

```bash
railway ssh --service dashboard "pgrep -af 'run_wisdom|enrich_link_authors|run_synthesis|run_sync_once' || true"
python3 - <<'PY'
import json
import os
import urllib.request
from http.cookiejar import CookieJar

base = os.environ["VIBEZ_REMOTE_URL"].rstrip("/")
code = os.environ["VIBEZ_ACCESS_CODE"]

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
login = urllib.request.Request(
    base + "/api/access",
    data=json.dumps({"code": code}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with opener.open(login, timeout=30):
    pass

for path in ["/api/links?stats=1", "/api/wisdom?stats=1", "/api/briefing"]:
    with opener.open(base + path, timeout=30) as resp:
        print(path, resp.status)
        print(resp.read().decode()[:800])
PY
```

Expected:
- no Railway background inference processes
- `/api/links` reflects the pushed link rows
- `/api/wisdom` reflects the pushed wisdom rows
- `/api/briefing` reflects the pushed daily report

- [ ] **Step 4: Complete the session landing workflow**

Run:

```bash
./.workgraph/handlers/task-completing.sh --cli codex
git pull --rebase
git push
git status --short --branch
```

Expected: handler succeeds, branch is pushed, working tree is clean, and `main` is up to date with `origin/main`.
