"""One-shot migration: SQLite -> Postgres for vibez-monitor.

Run: cd /Users/braydon/projects/personal/vibez-monitor && python backend/scripts/migrate_to_postgres.py
"""

import sqlite3
import sys
from pathlib import Path

try:
    import psycopg
except ImportError:
    # The 'backend' directory in sys.path shadows the psycopg package.
    # Remove it temporarily for the import.
    sys.path = [p for p in sys.path if not p.endswith('backend') or 'site-packages' in p]
    import psycopg

SQLITE_DB = Path("/Users/braydon/projects/personal/vibez-monitor/vibez.db")
PG_URL = "postgresql://braydon@localhost:5432/vibez_monitor"
BATCH_SIZE = 1000

# Columns that need type coercion: empty string -> None for date/timestamp types
DATE_COLUMNS = {
    "links": {"report_date", "first_seen", "last_seen"},
    "daily_reports": {"report_date", "generated_at"},
    "wisdom_topics": {"last_active", "created_at", "updated_at"},
    "wisdom_items": {"created_at", "updated_at"},
    "classifications": {"classified_at"},
    "messages": {"created_at"},
    "catchup_cache": set(),
    "api_budget": {"call_date", "created_at"},
    "api_usage_events": {"day_key", "created_at"},
}


def _coerce(row: tuple, col_names: list[str], table: str) -> tuple:
    date_cols = DATE_COLUMNS.get(table, set())
    result = []
    for i, val in enumerate(row):
        col = col_names[i]
        if col in date_cols and val == "":
            result.append(None)
        else:
            result.append(val)
    return tuple(result)

# ── Postgres DDL ──────────────────────────────────────────────────────────

PG_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_name TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    body TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    raw_event TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages (sender_id);

CREATE TABLE IF NOT EXISTS classifications (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),
    relevance_score INTEGER NOT NULL DEFAULT 0,
    topics TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '[]',
    contribution_flag INTEGER NOT NULL DEFAULT 0,
    contribution_themes TEXT NOT NULL DEFAULT '[]',
    contribution_hint TEXT,
    alert_level TEXT NOT NULL DEFAULT 'none',
    classified_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_classifications_alert ON classifications (alert_level);
CREATE INDEX IF NOT EXISTS idx_classifications_relevance ON classifications (relevance_score);

CREATE TABLE IF NOT EXISTS daily_reports (
    id SERIAL PRIMARY KEY,
    report_date DATE UNIQUE NOT NULL,
    briefing_md TEXT,
    briefing_json TEXT,
    contributions TEXT,
    trends TEXT,
    daily_memo TEXT,
    conversation_arcs TEXT,
    stats TEXT,
    generated_at TIMESTAMPTZ DEFAULT NOW()
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
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    title TEXT,
    category TEXT,
    relevance TEXT,
    shared_by TEXT,
    source_group TEXT,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
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
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT,
    message_count INTEGER DEFAULT 0,
    contributor_count INTEGER DEFAULT 0,
    last_active TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wisdom_items (
    id SERIAL PRIMARY KEY,
    topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    knowledge_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    source_links TEXT DEFAULT '[]',
    source_messages TEXT DEFAULT '[]',
    contributors TEXT DEFAULT '[]',
    confidence REAL DEFAULT 0.5,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wisdom_recommendations (
    id SERIAL PRIMARY KEY,
    from_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    to_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    strength REAL DEFAULT 0.0,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS catchup_cache (
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (start_date, end_date)
);

CREATE TABLE IF NOT EXISTS api_budget (
    id SERIAL PRIMARY KEY,
    call_date DATE NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_budget_date ON api_budget (call_date);

CREATE TABLE IF NOT EXISTS api_usage_events (
    id SERIAL PRIMARY KEY,
    day_key TEXT NOT NULL,
    route TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    client_ip TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    reason TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FTS replacement: GIN-indexed tsvector for links search
ALTER TABLE links ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;
CREATE INDEX IF NOT EXISTS idx_links_search_tsv ON links USING GIN (search_tsv);
CREATE OR REPLACE FUNCTION links_search_update() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_tsv := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.relevance, '') || ' ' || coalesce(NEW.category, '') || ' ' || coalesce(NEW.url, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_links_search_update ON links;
CREATE TRIGGER trg_links_search_update BEFORE INSERT OR UPDATE ON links
    FOR EACH ROW EXECUTE FUNCTION links_search_update();
"""

# ── Tables to migrate (in dependency order) ──────────────────────────────

TABLES = [
    "messages",
    "classifications",
    "daily_reports",
    "value_config",
    "sync_state",
    "links",
    "wisdom_topics",
    "wisdom_items",
    "wisdom_recommendations",
    "catchup_cache",
    "api_budget",
    "api_usage_events",
]


def migrate():
    if not SQLITE_DB.exists():
        print(f"SQLite DB not found: {SQLITE_DB}")
        sys.exit(1)

    sqconn = sqlite3.connect(str(SQLITE_DB))
    sqconn.row_factory = sqlite3.Row

    print(f"Connecting to Postgres: {PG_URL}")
    pgconn = psycopg.connect(PG_URL, autocommit=True)

    print("Creating schema...")
    pgconn.execute(PG_SCHEMA)

    for table in TABLES:
        count_row = sqconn.execute(f"SELECT COUNT(*) as cnt FROM {table}").fetchone()
        total = count_row["cnt"]
        if total == 0:
            print(f"  {table}: empty, skipping")
            continue

        print(f"  {table}: {total} rows...", end=" ", flush=True)
        offset = 0
        migrated = 0
        while offset < total:
            rows = sqconn.execute(
                f"SELECT * FROM {table} LIMIT {BATCH_SIZE} OFFSET {offset}"
            ).fetchall()
            if not rows:
                break
            cols = [desc[0] for desc in sqconn.execute(f"SELECT * FROM {table} LIMIT 0").description]
            placeholders = ", ".join(["%s"] * len(cols))
            col_names = ", ".join(cols)
            # ON CONFLICT DO NOTHING for idempotent re-runs
            pk_col = cols[0]
            if pk_col == "id" and table not in ("daily_reports", "links", "wisdom_topics", "wisdom_items", "wisdom_recommendations", "api_budget", "api_usage_events"):
                pass  # no conflict clause needed for text PKs with simple INSERT
            sql = f"INSERT INTO {table} ({col_names}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
            with pgconn.cursor() as cur:
                cur.executemany(sql, [_coerce(tuple(r), cols, table) for r in rows])
            migrated += len(rows)
            offset += BATCH_SIZE
        print(f"done ({migrated} rows)")

    # Update serial sequences
    for table in ("daily_reports", "links", "wisdom_topics", "wisdom_items", "wisdom_recommendations", "api_budget", "api_usage_events"):
        try:
            pgconn.execute(f"SELECT setval('{table}_id_seq', COALESCE((SELECT MAX(id) FROM {table}), 1))")
        except Exception:
            pass

    # Populate links search_tsv
    print("  Populating links search_tsv...")
    pgconn.execute("UPDATE links SET search_tsv = to_tsvector('english', coalesce(title, '') || ' ' || coalesce(relevance, '') || ' ' || coalesce(category, '') || ' ' || coalesce(url, ''))")
    print("  done")

    sqconn.close()
    pgconn.close()
    print("\nMigration complete. Resetting serial sequences done.")


if __name__ == "__main__":
    migrate()
