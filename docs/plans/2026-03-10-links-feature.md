# Links Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class Links section with NLP search, value ranking, and category filtering to vibez-monitor.

**Architecture:** New `links` table in SQLite for normalized link storage. Ingestion hook in synthesis pipeline upserts links after each daily report. NLP search via pgvector embeddings (FTS5 fallback). New Next.js page + API route. Backfill script for historical reports.

**Tech Stack:** Python (backend ingestion/backfill), TypeScript/Next.js (API route + page), SQLite (links table + FTS5), pgvector (link embeddings), better-sqlite3 (dashboard DB access).

**Design doc:** `docs/plans/2026-03-10-links-feature-design.md`

---

## Task 1: Links table schema + migration

**Files:**
- Modify: `backend/vibez/db.py` — add links table to SCHEMA, add migration in `_migrate()`
- Test: `backend/tests/test_links_db.py` — new file

**Step 1: Write the failing test**

```python
# backend/tests/test_links_db.py
"""Tests for links table schema and basic operations."""

import sqlite3
from pathlib import Path
from vibez.db import init_db, get_connection


def test_links_table_exists(tmp_path: Path):
    db_path = tmp_path / "test.db"
    init_db(db_path)
    conn = get_connection(db_path)
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert "links" in tables


def test_links_table_columns(tmp_path: Path):
    db_path = tmp_path / "test.db"
    init_db(db_path)
    conn = get_connection(db_path)
    cols = {row[1] for row in conn.execute("PRAGMA table_info(links)")}
    conn.close()
    expected = {
        "id", "url", "url_hash", "title", "category", "relevance",
        "shared_by", "source_group", "first_seen", "last_seen",
        "mention_count", "value_score", "report_date",
    }
    assert expected.issubset(cols)


def test_links_migration_on_existing_db(tmp_path: Path):
    """Verify migration adds links table to a DB that was created without it."""
    db_path = tmp_path / "test.db"
    # Create DB with old schema (no links table)
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY)")
    conn.execute("CREATE TABLE IF NOT EXISTS classifications (message_id TEXT PRIMARY KEY)")
    conn.execute("CREATE TABLE IF NOT EXISTS daily_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, report_date DATE)")
    conn.execute("CREATE TABLE IF NOT EXISTS value_config (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)")
    conn.commit()
    conn.close()
    # Run init_db which should migrate
    init_db(db_path)
    conn = get_connection(db_path)
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert "links" in tables
```

**Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_links_db.py -v
```

Expected: FAIL — `links` table does not exist.

**Step 3: Add links table to schema and migration**

In `backend/vibez/db.py`:

Add to end of `SCHEMA` string (before the closing `"""`):

```sql
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    title TEXT,
    category TEXT,
    relevance TEXT,
    shared_by TEXT,
    source_group TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    mention_count INTEGER DEFAULT 1,
    value_score REAL DEFAULT 0,
    report_date DATE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url_hash ON links (url_hash);
CREATE INDEX IF NOT EXISTS idx_links_category ON links (category);
CREATE INDEX IF NOT EXISTS idx_links_value_score ON links (value_score);
CREATE INDEX IF NOT EXISTS idx_links_last_seen ON links (last_seen);
```

Add to `_migrate()` function — check if links table exists and create it if not:

```python
# Check for links table and create if missing (for existing DBs)
existing_tables = {row[0] for row in conn.execute(
    "SELECT name FROM sqlite_master WHERE type='table'"
).fetchall()}
if "links" not in existing_tables:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            url_hash TEXT NOT NULL,
            title TEXT,
            category TEXT,
            relevance TEXT,
            shared_by TEXT,
            source_group TEXT,
            first_seen DATETIME,
            last_seen DATETIME,
            mention_count INTEGER DEFAULT 1,
            value_score REAL DEFAULT 0,
            report_date DATE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url_hash ON links (url_hash);
        CREATE INDEX IF NOT EXISTS idx_links_category ON links (category);
        CREATE INDEX IF NOT EXISTS idx_links_value_score ON links (value_score);
        CREATE INDEX IF NOT EXISTS idx_links_last_seen ON links (last_seen);
    """)
    changed = True
```

**Step 4: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_links_db.py -v
```

Expected: All 3 PASS.

**Step 5: Commit**

```bash
git add backend/vibez/db.py backend/tests/test_links_db.py
git commit -m "feat: add links table schema and migration"
```

---

## Task 2: Link ingestion module

**Files:**
- Create: `backend/vibez/links.py` — upsert_links(), compute_value_score(), backfill_links()
- Test: `backend/tests/test_links.py` — new file

**Step 1: Write the failing tests**

```python
# backend/tests/test_links.py
"""Tests for link ingestion, dedup, and value scoring."""

import hashlib
from datetime import datetime
from pathlib import Path

from vibez.db import init_db, get_connection
from vibez.links import upsert_links, compute_value_score, get_links


def _seed_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "test.db"
    init_db(db_path)
    return db_path


def test_upsert_links_inserts_new(tmp_path: Path):
    db_path = _seed_db(tmp_path)
    links = [
        {"url": "https://github.com/example/repo", "title": "Example Repo",
         "category": "repo", "relevance": "Useful for agent patterns"},
    ]
    upsert_links(db_path, links, report_date="2026-03-10",
                 shared_by="Dan", source_group="The vibez")
    rows = get_links(db_path, limit=10)
    assert len(rows) == 1
    assert rows[0]["url"] == "https://github.com/example/repo"
    assert rows[0]["title"] == "Example Repo"
    assert rows[0]["mention_count"] == 1
    assert rows[0]["shared_by"] == "Dan"


def test_upsert_links_dedup_bumps_count(tmp_path: Path):
    db_path = _seed_db(tmp_path)
    links = [{"url": "https://example.com", "title": "Example",
              "category": "article", "relevance": "Good read"}]
    upsert_links(db_path, links, report_date="2026-03-09",
                 shared_by="Alice", source_group="Group A")
    upsert_links(db_path, links, report_date="2026-03-10",
                 shared_by="Bob", source_group="Group B")
    rows = get_links(db_path, limit=10)
    assert len(rows) == 1
    assert rows[0]["mention_count"] == 2


def test_value_score_increases_with_mentions():
    score1 = compute_value_score(mention_count=1, days_ago=0)
    score2 = compute_value_score(mention_count=3, days_ago=0)
    assert score2 > score1


def test_value_score_decays_with_age():
    score_new = compute_value_score(mention_count=1, days_ago=0)
    score_old = compute_value_score(mention_count=1, days_ago=14)
    assert score_new > score_old


def test_get_links_filtered_by_category(tmp_path: Path):
    db_path = _seed_db(tmp_path)
    upsert_links(db_path, [
        {"url": "https://a.com", "title": "A", "category": "repo", "relevance": "x"},
        {"url": "https://b.com", "title": "B", "category": "article", "relevance": "y"},
    ], report_date="2026-03-10")
    repos = get_links(db_path, category="repo", limit=10)
    assert len(repos) == 1
    assert repos[0]["category"] == "repo"


def test_get_links_filtered_by_days(tmp_path: Path):
    db_path = _seed_db(tmp_path)
    upsert_links(db_path, [
        {"url": "https://old.com", "title": "Old", "category": "tool", "relevance": "x"},
    ], report_date="2026-01-01")
    upsert_links(db_path, [
        {"url": "https://new.com", "title": "New", "category": "tool", "relevance": "y"},
    ], report_date="2026-03-10")
    recent = get_links(db_path, days=7, limit=10)
    # Only the new link should appear (old is >7 days ago)
    urls = [r["url"] for r in recent]
    assert "https://new.com" in urls
```

**Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_links.py -v
```

Expected: FAIL — `vibez.links` module does not exist.

**Step 3: Implement links module**

```python
# backend/vibez/links.py
"""Link ingestion, dedup, value scoring, and retrieval."""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from vibez.db import get_connection


def _url_hash(url: str) -> str:
    normalized = url.strip().rstrip("/").lower()
    return hashlib.sha256(normalized.encode()).hexdigest()


def compute_value_score(mention_count: int = 1, days_ago: float = 0) -> float:
    mention_signal = math.log2(max(1, mention_count)) + 1
    recency = math.exp(-0.05 * max(0, days_ago))
    return round(mention_signal * recency, 4)


def upsert_links(
    db_path: Path,
    links: list[dict[str, Any]],
    report_date: str,
    shared_by: str = "",
    source_group: str = "",
) -> int:
    if not links:
        return 0
    conn = get_connection(db_path)
    now = datetime.now().isoformat()
    inserted = 0
    for link in links:
        url = str(link.get("url", "")).strip()
        if not url:
            continue
        h = _url_hash(url)
        existing = conn.execute(
            "SELECT id, mention_count, first_seen FROM links WHERE url_hash = ?", (h,)
        ).fetchone()
        if existing:
            new_count = (existing[1] or 1) + 1
            days_ago = (datetime.now() - datetime.fromisoformat(existing[2])).days if existing[2] else 0
            score = compute_value_score(new_count, days_ago)
            conn.execute(
                """UPDATE links SET mention_count = ?, last_seen = ?, value_score = ?,
                   report_date = ? WHERE id = ?""",
                (new_count, now, score, report_date, existing[0]),
            )
        else:
            score = compute_value_score(1, 0)
            conn.execute(
                """INSERT INTO links (url, url_hash, title, category, relevance,
                   shared_by, source_group, first_seen, last_seen, mention_count,
                   value_score, report_date)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (url, h, link.get("title", ""), link.get("category", ""),
                 link.get("relevance", ""), shared_by, source_group,
                 now, now, score, report_date),
            )
            inserted += 1
    conn.commit()
    conn.close()
    return inserted


def get_links(
    db_path: Path,
    *,
    category: str | None = None,
    days: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    conn = get_connection(db_path)
    where: list[str] = []
    params: list[Any] = []
    if category:
        where.append("category = ?")
        params.append(category)
    if days is not None:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        where.append("last_seen >= ?")
        params.append(cutoff)
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    params.append(min(max(1, limit), 200))
    rows = conn.execute(
        f"""SELECT id, url, url_hash, title, category, relevance, shared_by,
                   source_group, first_seen, last_seen, mention_count, value_score,
                   report_date
            FROM links {where_sql}
            ORDER BY value_score DESC, last_seen DESC
            LIMIT ?""",
        params,
    ).fetchall()
    conn.close()
    return [
        {
            "id": r[0], "url": r[1], "url_hash": r[2], "title": r[3],
            "category": r[4], "relevance": r[5], "shared_by": r[6],
            "source_group": r[7], "first_seen": r[8], "last_seen": r[9],
            "mention_count": r[10], "value_score": r[11], "report_date": r[12],
        }
        for r in rows
    ]
```

**Step 4: Run tests**

```bash
cd backend && python -m pytest tests/test_links.py -v
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add backend/vibez/links.py backend/tests/test_links.py
git commit -m "feat: add link ingestion module with dedup and value scoring"
```

---

## Task 3: NLP search — FTS5 + pgvector

**Files:**
- Modify: `backend/vibez/links.py` — add search_links_fts(), search_links_pgvector()
- Modify: `backend/vibez/semantic_index.py` — add link embedding functions
- Test: `backend/tests/test_links_search.py` — new file

**Step 1: Write the failing tests**

```python
# backend/tests/test_links_search.py
"""Tests for link NLP search (FTS5 fallback)."""

from pathlib import Path
from vibez.db import init_db
from vibez.links import upsert_links, search_links_fts


def _seed_links(tmp_path: Path) -> Path:
    db_path = tmp_path / "test.db"
    init_db(db_path)
    upsert_links(db_path, [
        {"url": "https://github.com/dan/trycycle", "title": "Trycycle - multi-attempt feature builder",
         "category": "repo", "relevance": "Agent retry patterns for feature development"},
        {"url": "https://arxiv.org/abs/1234", "title": "Attention Is All You Need",
         "category": "article", "relevance": "Foundational transformer paper"},
        {"url": "https://tool.dev/orchestrator", "title": "Agent Orchestrator Tool",
         "category": "tool", "relevance": "Multi-agent coordination framework"},
    ], report_date="2026-03-10", shared_by="Dan", source_group="The vibez")
    return db_path


def test_fts_search_finds_by_title(tmp_path: Path):
    db_path = _seed_links(tmp_path)
    results = search_links_fts(db_path, "trycycle")
    assert len(results) >= 1
    assert any("trycycle" in r["url"] for r in results)


def test_fts_search_finds_by_relevance(tmp_path: Path):
    db_path = _seed_links(tmp_path)
    results = search_links_fts(db_path, "retry patterns")
    assert len(results) >= 1
    assert any("trycycle" in r["url"] for r in results)


def test_fts_search_returns_empty_for_no_match(tmp_path: Path):
    db_path = _seed_links(tmp_path)
    results = search_links_fts(db_path, "xyznonexistent")
    assert len(results) == 0


def test_fts_search_respects_category_filter(tmp_path: Path):
    db_path = _seed_links(tmp_path)
    results = search_links_fts(db_path, "agent", category="tool")
    urls = [r["url"] for r in results]
    assert "https://tool.dev/orchestrator" in urls
    assert "https://github.com/dan/trycycle" not in urls
```

**Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_links_search.py -v
```

**Step 3: Implement FTS5 search**

Add to `backend/vibez/links.py`:

```python
def _ensure_fts(conn):
    """Create FTS5 virtual table for link search if not exists."""
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
            title, relevance, category, url,
            content='links', content_rowid='id'
        )
    """)
    # Rebuild if empty
    count = conn.execute("SELECT count(*) FROM links_fts").fetchone()[0]
    if count == 0:
        conn.execute("""
            INSERT INTO links_fts(rowid, title, relevance, category, url)
            SELECT id, coalesce(title,''), coalesce(relevance,''),
                   coalesce(category,''), coalesce(url,'')
            FROM links
        """)
        conn.commit()


def _sync_fts_row(conn, link_id: int):
    """Sync a single link row into FTS index."""
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
            title, relevance, category, url,
            content='links', content_rowid='id'
        )
    """)
    conn.execute("INSERT OR REPLACE INTO links_fts(rowid, title, relevance, category, url) "
                 "SELECT id, coalesce(title,''), coalesce(relevance,''), coalesce(category,''), coalesce(url,'') "
                 "FROM links WHERE id = ?", (link_id,))


def search_links_fts(
    db_path: Path,
    query: str,
    *,
    category: str | None = None,
    days: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search links using FTS5 full-text search."""
    conn = get_connection(db_path)
    _ensure_fts(conn)
    q = query.strip()
    if not q:
        conn.close()
        return get_links(db_path, category=category, days=days, limit=limit)

    # FTS5 query — quote terms for safety
    fts_query = " OR ".join(f'"{term}"' for term in q.split() if term)

    where: list[str] = []
    params: list[Any] = []
    if category:
        where.append("l.category = ?")
        params.append(category)
    if days is not None:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        where.append("l.last_seen >= ?")
        params.append(cutoff)
    extra_where = f"AND {' AND '.join(where)}" if where else ""
    params.append(min(max(1, limit), 200))

    rows = conn.execute(
        f"""SELECT l.id, l.url, l.url_hash, l.title, l.category, l.relevance,
                   l.shared_by, l.source_group, l.first_seen, l.last_seen,
                   l.mention_count, l.value_score, l.report_date
            FROM links_fts f
            JOIN links l ON f.rowid = l.id
            WHERE links_fts MATCH ?
            {extra_where}
            ORDER BY rank, l.value_score DESC
            LIMIT ?""",
        (fts_query, *params),
    ).fetchall()
    conn.close()
    return [
        {
            "id": r[0], "url": r[1], "url_hash": r[2], "title": r[3],
            "category": r[4], "relevance": r[5], "shared_by": r[6],
            "source_group": r[7], "first_seen": r[8], "last_seen": r[9],
            "mention_count": r[10], "value_score": r[11], "report_date": r[12],
        }
        for r in rows
    ]
```

Also update `upsert_links()` to call `_sync_fts_row()` after each insert/update.

**Step 4: Run tests**

```bash
cd backend && python -m pytest tests/test_links_search.py -v
```

**Step 5: Commit**

```bash
git add backend/vibez/links.py backend/tests/test_links_search.py
git commit -m "feat: add FTS5 search for links"
```

---

## Task 4: Synthesis ingestion hook

**Files:**
- Modify: `backend/vibez/synthesis.py` — call upsert_links() after save_daily_report()
- Test: `backend/tests/test_links_ingestion.py` — new file

**Step 1: Write the failing test**

```python
# backend/tests/test_links_ingestion.py
"""Test that synthesis pipeline ingests links into the links table."""

from pathlib import Path
from vibez.db import init_db, get_connection
from vibez.synthesis import save_daily_report
from vibez.links import get_links


def test_save_daily_report_ingests_links(tmp_path: Path):
    db_path = tmp_path / "test.db"
    init_db(db_path)
    report = {
        "daily_memo": "Test memo",
        "briefing": [{"title": "Thread 1", "participants": ["Dan"],
                       "insights": "Good stuff", "links": ["https://example.com"]}],
        "contributions": [],
        "trends": {},
        "links": [
            {"url": "https://github.com/cool/repo", "title": "Cool Repo",
             "category": "repo", "relevance": "Useful"},
            {"url": "https://arxiv.org/abs/999", "title": "Paper",
             "category": "article", "relevance": "Research"},
        ],
    }
    save_daily_report(db_path, "2026-03-10", report, "# Test briefing")
    links = get_links(db_path, limit=10)
    assert len(links) == 2
    urls = {l["url"] for l in links}
    assert "https://github.com/cool/repo" in urls
    assert "https://arxiv.org/abs/999" in urls
```

**Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_links_ingestion.py -v
```

Expected: FAIL — `save_daily_report` doesn't ingest links yet.

**Step 3: Hook ingestion into save_daily_report**

In `backend/vibez/synthesis.py`, add import at top:

```python
from vibez.links import upsert_links
```

At the end of `save_daily_report()`, after `conn.close()`, add:

```python
# Ingest extracted links into dedicated links table
report_links = report.get("links", [])
if report_links:
    upsert_links(db_path, report_links, report_date=report_date)
```

**Step 4: Run test**

```bash
cd backend && python -m pytest tests/test_links_ingestion.py -v
```

**Step 5: Commit**

```bash
git add backend/vibez/synthesis.py backend/tests/test_links_ingestion.py
git commit -m "feat: hook link ingestion into synthesis pipeline"
```

---

## Task 5: Backfill script

**Files:**
- Create: `backend/scripts/backfill_links.py`
- Test: `backend/tests/test_links_backfill.py`

**Step 1: Write the failing test**

```python
# backend/tests/test_links_backfill.py
"""Test backfill of links from existing daily_reports."""

import json
from pathlib import Path
from vibez.db import init_db, get_connection
from vibez.links import get_links


def _seed_reports(db_path: Path):
    conn = get_connection(db_path)
    conn.execute(
        """INSERT INTO daily_reports (report_date, briefing_json, stats)
           VALUES (?, ?, ?)""",
        ("2026-03-08",
         json.dumps([{"title": "T1", "links": ["https://a.com"]}]),
         json.dumps([
            {"url": "https://b.com", "title": "B Link", "category": "repo", "relevance": "Good"},
         ])),
    )
    conn.execute(
        """INSERT INTO daily_reports (report_date, briefing_json, stats)
           VALUES (?, ?, ?)""",
        ("2026-03-09",
         json.dumps([{"title": "T2", "links": ["https://c.com"]}]),
         json.dumps([
            {"url": "https://b.com", "title": "B Link v2", "category": "repo", "relevance": "Still good"},
         ])),
    )
    conn.commit()
    conn.close()


def test_backfill_populates_links(tmp_path: Path):
    db_path = tmp_path / "test.db"
    init_db(db_path)
    _seed_reports(db_path)

    # Import and run backfill
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    from backfill_links import backfill
    backfill(db_path)

    links = get_links(db_path, limit=20)
    assert len(links) >= 1
    # b.com appeared in 2 reports — should have mention_count >= 2
    b_links = [l for l in links if "b.com" in l["url"]]
    assert len(b_links) == 1
    assert b_links[0]["mention_count"] >= 2
```

**Step 2: Run test**

```bash
cd backend && python -m pytest tests/test_links_backfill.py -v
```

**Step 3: Implement backfill script**

```python
# backend/scripts/backfill_links.py
"""Backfill links table from existing daily_reports."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.db import init_db, get_connection
from vibez.links import upsert_links


def backfill(db_path: Path) -> int:
    init_db(db_path)
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT report_date, briefing_json, stats FROM daily_reports ORDER BY report_date ASC"
    ).fetchall()
    conn.close()

    total = 0
    for report_date, briefing_json, stats_json in rows:
        links: list[dict] = []
        # stats column stores the top-level "links" array from synthesis
        if stats_json:
            try:
                stats_links = json.loads(stats_json)
                if isinstance(stats_links, list):
                    links.extend(stats_links)
            except json.JSONDecodeError:
                pass
        if links:
            total += upsert_links(db_path, links, report_date=report_date)

    return total


if __name__ == "__main__":
    db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vibez.db")
    count = backfill(db)
    print(f"Backfilled {count} links from existing reports.")
```

NOTE: The synthesis `save_daily_report()` stores the links array in the `stats` column (see line 464 of synthesis.py: `json.dumps(report.get("links", []))`). The backfill reads from that column.

**Step 4: Run test**

```bash
cd backend && python -m pytest tests/test_links_backfill.py -v
```

**Step 5: Commit**

```bash
git add backend/scripts/backfill_links.py backend/tests/test_links_backfill.py
git commit -m "feat: add backfill script for historical links"
```

---

## Task 6: Dashboard API route — GET /api/links

**Files:**
- Create: `dashboard/src/app/api/links/route.ts`
- Modify: `dashboard/src/lib/db.ts` — add getLinks(), searchLinksFts()

**Step 1: Add DB functions to lib/db.ts**

Add to `dashboard/src/lib/db.ts`:

```typescript
export interface LinkRow {
  id: number;
  url: string;
  url_hash: string;
  title: string | null;
  category: string | null;
  relevance: string | null;
  shared_by: string | null;
  source_group: string | null;
  first_seen: string | null;
  last_seen: string | null;
  mention_count: number;
  value_score: number;
  report_date: string | null;
}

export function getLinks(opts: {
  category?: string;
  days?: number;
  limit?: number;
}): LinkRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
    where.push("last_seen >= ?");
    params.push(cutoff);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(1, opts.limit || 50), 200);
  params.push(limit);
  return db
    .prepare(
      `SELECT id, url, url_hash, title, category, relevance, shared_by,
              source_group, first_seen, last_seen, mention_count, value_score,
              report_date
       FROM links ${whereSql}
       ORDER BY value_score DESC, last_seen DESC
       LIMIT ?`
    )
    .all(...params) as LinkRow[];
}

export function searchLinksFts(
  query: string,
  opts: { category?: string; days?: number; limit?: number }
): LinkRow[] {
  const db = getDb();
  // Ensure FTS table exists
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
      title, relevance, category, url,
      content='links', content_rowid='id'
    )
  `);
  const count = (db.prepare("SELECT count(*) as c FROM links_fts").get() as { c: number }).c;
  if (count === 0) {
    db.exec(`
      INSERT INTO links_fts(rowid, title, relevance, category, url)
      SELECT id, coalesce(title,''), coalesce(relevance,''),
             coalesce(category,''), coalesce(url,'')
      FROM links
    `);
  }

  const terms = query.trim().split(/\s+/).filter(Boolean);
  const ftsQuery = terms.map((t) => `"${t}"`).join(" OR ");
  if (!ftsQuery) return getLinks(opts);

  const where: string[] = [];
  const params: unknown[] = [ftsQuery];
  if (opts.category) {
    where.push("l.category = ?");
    params.push(opts.category);
  }
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
    where.push("l.last_seen >= ?");
    params.push(cutoff);
  }
  const extraWhere = where.length ? `AND ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(1, opts.limit || 50), 200);
  params.push(limit);

  return db
    .prepare(
      `SELECT l.id, l.url, l.url_hash, l.title, l.category, l.relevance,
              l.shared_by, l.source_group, l.first_seen, l.last_seen,
              l.mention_count, l.value_score, l.report_date
       FROM links_fts f
       JOIN links l ON f.rowid = l.id
       WHERE links_fts MATCH ?
       ${extraWhere}
       ORDER BY rank, l.value_score DESC
       LIMIT ?`
    )
    .all(...params) as LinkRow[];
}
```

**Step 2: Create API route**

```typescript
// dashboard/src/app/api/links/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getLinks, searchLinksFts } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const q = params.get("q")?.trim() || "";
    const category = params.get("category") || undefined;
    const days = params.has("days") ? parseInt(params.get("days")!, 10) : 14;
    const limit = params.has("limit") ? parseInt(params.get("limit")!, 10) : 50;

    const opts = { category, days, limit };
    const links = q ? searchLinksFts(q, opts) : getLinks(opts);

    return NextResponse.json({ links, total: links.length });
  } catch (err) {
    console.error("Links API error:", err);
    return NextResponse.json({ links: [], total: 0, error: "Internal error" }, { status: 500 });
  }
}
```

**Step 3: Commit**

```bash
git add dashboard/src/app/api/links/route.ts dashboard/src/lib/db.ts
git commit -m "feat: add GET /api/links endpoint with FTS search"
```

---

## Task 7: Links frontend page

**Files:**
- Create: `dashboard/src/app/links/page.tsx`
- Modify: `dashboard/src/components/Nav.tsx` — add Links to nav

**Step 1: Create the Links page**

```tsx
// dashboard/src/app/links/page.tsx
"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface Link {
  id: number;
  url: string;
  title: string | null;
  category: string | null;
  relevance: string | null;
  shared_by: string | null;
  source_group: string | null;
  first_seen: string | null;
  last_seen: string | null;
  mention_count: number;
  value_score: number;
}

const CATEGORIES = ["all", "tool", "repo", "article", "discussion"] as const;

const STARTER_PROMPTS = [
  "Repos shared this week",
  "Tools for agent orchestration",
  "Most discussed links",
  "Papers about transformers",
];

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function categoryColor(cat: string | null): string {
  switch (cat) {
    case "tool": return "border-emerald-400/50 text-emerald-300";
    case "repo": return "border-violet-400/50 text-violet-300";
    case "article": return "border-amber-400/50 text-amber-300";
    case "discussion": return "border-sky-400/50 text-sky-300";
    default: return "border-slate-600 text-slate-400";
  }
}

export default function LinksPage() {
  const [links, setLinks] = useState<Link[]>([]);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchLinks = useCallback(async (q: string, cat: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (cat !== "all") params.set("category", cat);
      params.set("days", "30");
      params.set("limit", "60");
      const res = await fetch(`/api/links?${params}`);
      const data = await res.json();
      setLinks(data.links || []);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLinks("", "all");
  }, [fetchLinks]);

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchLinks(value, activeCategory);
    }, 300);
  }

  function handleCategoryChange(cat: string) {
    setActiveCategory(cat);
    fetchLinks(query, cat);
  }

  function handlePrompt(prompt: string) {
    setQuery(prompt);
    fetchLinks(prompt, activeCategory);
  }

  return (
    <div className="fade-up space-y-6">
      <header className="space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">Links</h1>
        <p className="vibe-subtitle">Search shared links by describing what you remember.</p>
      </header>

      <div className="space-y-3">
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Describe what you're looking for..."
          className="vibe-input w-full rounded-lg px-4 py-3 text-sm"
          aria-label="Search links"
        />

        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition ${
                activeCategory === cat
                  ? "border-cyan-400/60 bg-cyan-900/30 text-cyan-200"
                  : "border-slate-700/60 bg-slate-900/30 text-slate-400 hover:border-slate-500"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <p className="text-sm text-slate-400">Searching...</p>
      )}

      {!loading && links.length === 0 && !query && (
        <div className="vibe-panel rounded-xl p-6 text-center">
          <p className="mb-4 text-sm text-slate-300">Try a search</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => handlePrompt(prompt)}
                className="rounded-md border border-slate-700/70 bg-slate-900/45 px-3 py-2 text-left text-sm text-slate-400 hover:border-cyan-300/60 hover:text-slate-200"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {!loading && links.length === 0 && query && (
        <p className="text-sm text-slate-500">No links found for "{query}"</p>
      )}

      <div className="space-y-2">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="vibe-panel block rounded-lg px-4 py-3 transition hover:border-cyan-400/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">
                  {link.title || hostname(link.url)}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{hostname(link.url)}</p>
                {link.relevance && (
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{link.relevance}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                  {link.shared_by && <span>by {link.shared_by}</span>}
                  {link.source_group && <span>in {link.source_group}</span>}
                  {link.last_seen && (
                    <span>{new Date(link.last_seen).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {link.category && (
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] capitalize ${categoryColor(link.category)}`}>
                    {link.category}
                  </span>
                )}
                {link.mention_count > 1 && (
                  <span className="text-[10px] text-slate-500">
                    shared {link.mention_count}x
                  </span>
                )}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Add Links to Nav**

In `dashboard/src/components/Nav.tsx`, add to `ALL_LINKS` array after the Briefing entry:

```typescript
{ href: "/links", label: "Links" },
```

Add to `PAGE_INTENT`:

```typescript
"/links": "Semantic link search: find shared resources by describing what you remember.",
```

**Step 3: Commit**

```bash
git add dashboard/src/app/links/page.tsx dashboard/src/components/Nav.tsx
git commit -m "feat: add Links page with NLP search UI"
```

---

## Task 8: Build, E2E smoke test, and fix loop

**Step 1: Run backfill on real database**

```bash
cd backend && python scripts/backfill_links.py ../vibez.db
```

**Step 2: Run backend tests**

```bash
cd backend && python -m pytest tests/test_links_db.py tests/test_links.py tests/test_links_search.py tests/test_links_ingestion.py tests/test_links_backfill.py -v
```

Fix any failures before proceeding.

**Step 3: Build dashboard**

```bash
cd dashboard && npm run build
```

Fix any TypeScript/build errors.

**Step 4: Restart dashboard and verify**

```bash
launchctl kickstart -k gui/$(id -u)/com.vibez-monitor.dashboard
```

**Step 5: E2E smoke test with Playwright**

Use Playwright MCP to:
1. Navigate to `http://localhost:3100/links`
2. Verify page loads with search bar and starter prompts
3. Type a search query and verify results appear
4. Click a category pill and verify filtering works
5. Screenshot the final state

**Step 6: Fix loop** — if any E2E test fails, diagnose, fix, rebuild, re-test until stable.

**Step 7: Run full existing test suite**

```bash
cd backend && python -m pytest -v
```

Ensure no regressions.

**Step 8: Final commit**

```bash
git add -A
git commit -m "feat: links feature complete — schema, ingestion, search, UI"
```

---

## Task 9: Merge and handoff

**Step 1: Verify clean state**

```bash
git status
git log --oneline -10
```

**Step 2: User manually pushes to Railway**

Braydon pushes to Railway after verifying locally.
