# ABOUTME: Test backfill of links from existing daily_reports.
# ABOUTME: Verifies that historical reports populate the links table with correct dedup.

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
