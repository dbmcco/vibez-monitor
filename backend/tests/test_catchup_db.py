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
