import json
import sqlite3
from pathlib import Path

from vibez.db import init_db
from backend.scripts import push_remote
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


def test_fetch_sync_state_includes_analysis_watermarks_but_not_local_cursors(
    tmp_path: Path,
):
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


def test_push_analysis_tables_sends_each_table_in_its_own_section(
    tmp_path: Path,
    monkeypatch,
):
    db_path = tmp_path / "vibez.db"
    init_db(db_path)
    _seed_analysis_tables(db_path)

    seen_payloads: list[dict[str, object]] = []

    def fake_push_section(
        remote_url: str,
        push_key: str,
        access_cookie: str,
        payload: dict[str, object],
    ) -> dict[str, object]:
        assert remote_url == "https://example.com"
        assert push_key == "push-key"
        assert access_cookie == "cookie=value"
        seen_payloads.append(payload)
        return {"ok": True}

    monkeypatch.setattr(push_remote, "push_section", fake_push_section)

    push_remote.push_analysis_tables(
        remote_url="https://example.com",
        push_key="push-key",
        access_cookie="cookie=value",
        db_path=db_path,
        sync_state={"wisdom_last_run": "1776160800000"},
        batch_size=1,
    )

    assert seen_payloads == [
        {"links": fetch_links(db_path)},
        {"daily_reports": fetch_daily_reports(db_path)},
        {"wisdom_topics": fetch_wisdom_topics(db_path)},
        {"wisdom_items": fetch_wisdom_items(db_path)},
        {"wisdom_recommendations": fetch_wisdom_recommendations(db_path)},
        {"sync_state": {"wisdom_last_run": "1776160800000"}},
    ]
