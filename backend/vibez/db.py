"""SQLite database schema and connection management."""

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
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

CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages (sender_id);

CREATE TABLE IF NOT EXISTS classifications (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),
    relevance_score INTEGER NOT NULL DEFAULT 0,
    topics TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '[]',
    contribution_flag BOOLEAN NOT NULL DEFAULT 0,
    contribution_themes TEXT NOT NULL DEFAULT '[]',
    contribution_hint TEXT,
    alert_level TEXT NOT NULL DEFAULT 'none',
    classified_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_classifications_alert ON classifications (alert_level);
CREATE INDEX IF NOT EXISTS idx_classifications_relevance ON classifications (relevance_score);

CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE UNIQUE NOT NULL,
    briefing_md TEXT,
    briefing_json TEXT,
    contributions TEXT,
    trends TEXT,
    daily_memo TEXT,
    conversation_arcs TEXT,
    stats TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS value_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_VALUE_CONFIG = {
    "topics": [
        "agentic-architecture",
        "multi-agent-systems",
        "context-management",
        "orchestration",
        "practical-tools",
        "repos",
        "business-ai",
        "productivity",
    ],
    "projects": [
        "core-platform",
        "automation-tooling",
        "knowledge-system",
        "analytics-pipeline",
        "integration-workflows",
        "ops-infrastructure",
    ],
    "alert_threshold": 7,
}


def get_connection(db_path: str | Path) -> sqlite3.Connection:
    """Get a SQLite connection with WAL mode enabled."""
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Run schema migrations on existing databases."""
    changed = False
    cols = {row[1] for row in conn.execute("PRAGMA table_info(classifications)")}
    if "contribution_themes" not in cols:
        conn.execute(
            "ALTER TABLE classifications ADD COLUMN contribution_themes TEXT NOT NULL DEFAULT '[]'"
        )
        changed = True

    report_cols = {row[1] for row in conn.execute("PRAGMA table_info(daily_reports)")}
    if "daily_memo" not in report_cols:
        conn.execute("ALTER TABLE daily_reports ADD COLUMN daily_memo TEXT")
        changed = True
    if "conversation_arcs" not in report_cols:
        conn.execute("ALTER TABLE daily_reports ADD COLUMN conversation_arcs TEXT")
        changed = True

    if changed:
        conn.commit()


def init_db(db_path: str | Path) -> None:
    """Initialize the database schema. Idempotent."""
    conn = get_connection(db_path)
    conn.executescript(SCHEMA)
    _migrate(conn)
    cursor = conn.execute("SELECT COUNT(*) FROM value_config")
    if cursor.fetchone()[0] == 0:
        for key, value in DEFAULT_VALUE_CONFIG.items():
            conn.execute(
                "INSERT OR IGNORE INTO value_config (key, value) VALUES (?, ?)",
                (key, json.dumps(value)),
            )
    conn.commit()
    conn.close()
