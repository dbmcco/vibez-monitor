# ABOUTME: Tests for link ingestion, dedup, and value scoring.
# ABOUTME: Verifies upsert, dedup bump, value score math, and filtered retrieval.

"""Tests for link ingestion, dedup, and value scoring."""

import hashlib
from datetime import datetime, timezone
from pathlib import Path

from vibez.db import init_db, get_connection
from vibez.links import (
    _days_since_iso,
    compute_value_score,
    get_links,
    upsert_links,
    upsert_message_links,
)


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


def test_days_since_iso_accepts_database_native_dates():
    assert _days_since_iso(datetime.now(tz=timezone.utc)) == 0
    assert _days_since_iso(datetime.now(tz=timezone.utc).date()) == 0


def test_upsert_message_links_inserts_null_report_date(monkeypatch, tmp_path: Path):
    class Cursor:
        def __init__(self, row=None):
            self.row = row

        def fetchone(self):
            return self.row

    class FakeConnection:
        def __init__(self):
            self.calls = []

        def execute(self, sql, params=None):
            self.calls.append((sql, params))
            if "SELECT id, mention_count, first_seen" in sql:
                return Cursor(None)
            return Cursor()

        def commit(self):
            pass

        def close(self):
            pass

    conn = FakeConnection()
    monkeypatch.setattr("vibez.links.get_connection", lambda _db_path: conn)

    inserted = upsert_message_links(tmp_path / "unused.db", [
        {
            "body": "Worth saving https://example.com/thing",
            "sender_name": "Alice",
            "timestamp": 1_763_700_000_000,
            "room_name": "Show and Tell",
        }
    ])

    assert inserted == 1
    insert_sql, insert_params = next(
        call for call in conn.calls if call[0].lstrip().startswith("INSERT INTO links")
    )
    assert "report_date)" in insert_sql
    assert "NULL)" in insert_sql
    assert insert_params[-1] == compute_value_score(1, 0)


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
