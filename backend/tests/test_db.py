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
