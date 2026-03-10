# ABOUTME: Test that synthesis pipeline ingests links into the links table.
# ABOUTME: Verifies save_daily_report hooks into upsert_links for extracted links.

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
