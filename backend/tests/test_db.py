import sqlite3
from vibez.db import init_db, get_connection


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
    assert "wisdom_topics" in tables
    assert "wisdom_items" in tables
    assert "wisdom_recommendations" in tables


def test_init_db_is_idempotent(tmp_db):
    init_db(tmp_db)
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cursor = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'"
    )
    assert cursor.fetchone()[0] == 1


def test_insert_and_read_message(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("$event1", "!room1:beeper.local", "The vibez (code code code)",
         "@user1:beeper.local", "Harper", "check out this repo", 1708300000000,
         '{"type": "m.room.message"}'),
    )
    conn.commit()
    cursor = conn.execute("SELECT sender_name, body FROM messages WHERE id = ?", ("$event1",))
    row = cursor.fetchone()
    assert row[0] == "Harper"
    assert row[1] == "check out this repo"


def test_insert_and_read_classification(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES ('$ev1', '!r1:b.l', 'vibez', '@u:b', 'Sam', 'test', 1000, '{}')"""
    )
    conn.execute(
        """INSERT INTO classifications (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level)
           VALUES ('$ev1', 8, '["agentic-arch"]', '["amplifier"]', 1, 'Your driftdriver relates', 'hot')"""
    )
    conn.commit()
    cursor = conn.execute(
        "SELECT c.relevance_score, c.alert_level FROM classifications c WHERE c.message_id = '$ev1'"
    )
    row = cursor.fetchone()
    assert row[0] == 8
    assert row[1] == "hot"


def test_default_value_config_seeded(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cursor = conn.execute("SELECT COUNT(*) FROM value_config")
    assert cursor.fetchone()[0] == 3  # topics, projects, alert_threshold


def test_daily_report_extended_columns_present(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    cols = {
        row[1] for row in conn.execute("PRAGMA table_info(daily_reports)")
    }
    assert "daily_memo" in cols
    assert "conversation_arcs" in cols


def test_init_db_migrates_existing_db_with_missing_wisdom_tables(tmp_db):
    conn = sqlite3.connect(tmp_db)
    conn.executescript(
        """
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            room_name TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            body TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            raw_event TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE classifications (
            message_id TEXT PRIMARY KEY REFERENCES messages(id),
            relevance_score INTEGER NOT NULL DEFAULT 0,
            topics TEXT NOT NULL DEFAULT '[]',
            entities TEXT NOT NULL DEFAULT '[]',
            contribution_flag BOOLEAN NOT NULL DEFAULT 0,
            contribution_hint TEXT,
            alert_level TEXT NOT NULL DEFAULT 'none',
            classified_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE daily_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_date DATE UNIQUE NOT NULL,
            briefing_md TEXT,
            briefing_json TEXT,
            contributions TEXT,
            trends TEXT,
            stats TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE value_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()

    init_db(tmp_db)

    conn = get_connection(tmp_db)
    tables = {
        row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "wisdom_topics" in tables
    assert "wisdom_items" in tables
    assert "wisdom_recommendations" in tables
