# ABOUTME: Tests for links table schema and basic operations.
# ABOUTME: Verifies links table creation, columns, and migration on existing DBs.

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
    conn.execute("""CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, room_id TEXT, room_name TEXT, sender_id TEXT,
        sender_name TEXT, body TEXT, timestamp INTEGER, raw_event TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS classifications (
        message_id TEXT PRIMARY KEY, relevance_score INTEGER DEFAULT 0,
        topics TEXT DEFAULT '[]', entities TEXT DEFAULT '[]',
        contribution_flag BOOLEAN DEFAULT 0, contribution_hint TEXT,
        alert_level TEXT DEFAULT 'none', classified_at DATETIME DEFAULT CURRENT_TIMESTAMP)""")
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
