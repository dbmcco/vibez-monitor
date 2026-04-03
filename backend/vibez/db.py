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

CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    title TEXT,
    category TEXT,
    relevance TEXT,
    shared_by TEXT,
    source_group TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    mention_count INTEGER DEFAULT 1,
    value_score REAL DEFAULT 0,
    report_date DATE,
    authored_by TEXT,
    pinned INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url_hash ON links (url_hash);
CREATE INDEX IF NOT EXISTS idx_links_category ON links (category);
CREATE INDEX IF NOT EXISTS idx_links_value_score ON links (value_score);
CREATE INDEX IF NOT EXISTS idx_links_last_seen ON links (last_seen);

CREATE TABLE IF NOT EXISTS wisdom_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT,
    message_count INTEGER DEFAULT 0,
    contributor_count INTEGER DEFAULT 0,
    last_active DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wisdom_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    knowledge_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    source_links TEXT DEFAULT '[]',
    source_messages TEXT DEFAULT '[]',
    contributors TEXT DEFAULT '[]',
    confidence REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wisdom_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    to_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    strength REAL DEFAULT 0.0,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS catchup_cache (
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (start_date, end_date)
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

WISDOM_SCHEMA = """
CREATE TABLE IF NOT EXISTS wisdom_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT,
    message_count INTEGER DEFAULT 0,
    contributor_count INTEGER DEFAULT 0,
    last_active DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wisdom_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    knowledge_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    source_links TEXT DEFAULT '[]',
    source_messages TEXT DEFAULT '[]',
    contributors TEXT DEFAULT '[]',
    confidence REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wisdom_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    to_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    strength REAL DEFAULT 0.0,
    reason TEXT
);
"""


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

    # Check for links table and create if missing (for existing DBs)
    existing_tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    if "links" not in existing_tables:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                url_hash TEXT NOT NULL,
                title TEXT,
                category TEXT,
                relevance TEXT,
                shared_by TEXT,
                source_group TEXT,
                first_seen DATETIME,
                last_seen DATETIME,
                mention_count INTEGER DEFAULT 1,
                value_score REAL DEFAULT 0,
                report_date DATE,
                authored_by TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url_hash ON links (url_hash);
            CREATE INDEX IF NOT EXISTS idx_links_category ON links (category);
            CREATE INDEX IF NOT EXISTS idx_links_value_score ON links (value_score);
            CREATE INDEX IF NOT EXISTS idx_links_last_seen ON links (last_seen);
        """)
        changed = True

    # Add authored_by and pinned columns to existing links tables
    if "links" in existing_tables:
        link_cols = {row[1] for row in conn.execute("PRAGMA table_info(links)")}
        if "authored_by" not in link_cols:
            conn.execute("ALTER TABLE links ADD COLUMN authored_by TEXT")
            changed = True
        if "pinned" not in link_cols:
            conn.execute("ALTER TABLE links ADD COLUMN pinned INTEGER DEFAULT 0")
            changed = True

    if (
        "wisdom_topics" not in existing_tables
        or "wisdom_items" not in existing_tables
        or "wisdom_recommendations" not in existing_tables
    ):
        conn.executescript(WISDOM_SCHEMA)
        changed = True

    if "catchup_cache" not in existing_tables:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS catchup_cache (
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                stale INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (start_date, end_date)
            );
        """)
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


def invalidate_catchup_for_date(db_path: str | Path, date: str) -> None:
    """Mark catchup cache entries stale if their window contains the given date."""
    conn = get_connection(db_path)
    conn.execute(
        "UPDATE catchup_cache SET stale = 1 WHERE start_date <= ? AND end_date >= ?",
        (date, date),
    )
    conn.commit()
    conn.close()
