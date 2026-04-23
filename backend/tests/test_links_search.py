# ABOUTME: Tests for link NLP search using FTS5 full-text search.
# ABOUTME: Verifies search by title, relevance, empty results, and category filtering.

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


def _seed_possessive_links(tmp_path: Path) -> Path:
    db_path = tmp_path / "possessive.db"
    init_db(db_path)
    upsert_links(
        db_path,
        [
            {
                "url": "https://wiki.thirdgulfwar.com/",
                "title": "wiki.thirdgulfwar.com",
                "category": "article",
                "relevance": "I built a personal knowledge base around the Iran war. [Schuyler topics: geopolitics]",
            },
            {
                "url": "https://www.outcryai.com/library",
                "title": "outcryai.com",
                "category": "article",
                "relevance": "Example research report on Iran site",
            },
        ],
        report_date="2026-03-17",
        shared_by="Nat",
        source_group="Show and Tell",
    )
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


def test_fts_search_normalizes_possessive_terms(tmp_path: Path):
    db_path = _seed_possessive_links(tmp_path)

    possessive_results = search_links_fts(db_path, "schuyler's")
    ranked_results = search_links_fts(db_path, "schuyler's iran site")

    assert any(r["url"] == "https://wiki.thirdgulfwar.com/" for r in possessive_results)
    assert ranked_results[0]["url"] == "https://wiki.thirdgulfwar.com/"
