# Vibez Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an attention firewall for the Vibez WhatsApp ecosystem — real-time capture via Beeper/Matrix, Sonnet classification, daily synthesis, and a Next.js dashboard.

**Architecture:** Python backend (Matrix sync + classifier + synthesis) writes to SQLite. Next.js dashboard reads from the same SQLite. Two launchd services: persistent sync + daily cron. Beeper bridges WhatsApp into Matrix protocol; we consume the Matrix Client-Server API.

**Tech Stack:** Python 3.14, httpx (async HTTP), anthropic SDK, SQLite. Next.js 14 (App Router), better-sqlite3, Tailwind CSS. launchd for process management.

---

## Project Structure

```
vibez-monitor/
├── backend/
│   ├── vibez/
│   │   ├── __init__.py
│   │   ├── config.py           # Configuration + secrets
│   │   ├── db.py               # SQLite schema + connection
│   │   ├── matrix_sync.py      # Matrix sync service
│   │   ├── classifier.py       # Sonnet classifier
│   │   └── synthesis.py        # Daily synthesis agent
│   ├── scripts/
│   │   ├── run_sync.py         # Entry point: sync service
│   │   ├── run_synthesis.py    # Entry point: daily synthesis
│   │   └── backfill.py         # Import existing WhatsApp exports
│   ├── tests/
│   │   ├── conftest.py
│   │   ├── test_db.py
│   │   ├── test_matrix_sync.py
│   │   ├── test_classifier.py
│   │   └── test_synthesis.py
│   └── pyproject.toml
├── dashboard/
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx              # Live Feed
│   │   │   ├── briefing/page.tsx     # Morning Briefing
│   │   │   ├── contribute/page.tsx   # Contribution Board
│   │   │   └── settings/page.tsx     # Settings
│   │   ├── components/
│   │   │   ├── MessageCard.tsx
│   │   │   ├── BriefingView.tsx
│   │   │   ├── ContributionCard.tsx
│   │   │   ├── Nav.tsx
│   │   │   └── RelevanceBadge.tsx
│   │   └── lib/
│   │       └── db.ts                 # SQLite reader
│   ├── package.json
│   ├── next.config.ts
│   ├── tailwind.config.ts
│   └── tsconfig.json
├── launchd/
│   ├── com.vibez-monitor.sync.plist
│   └── com.vibez-monitor.synthesis.plist
├── .env                              # ANTHROPIC_API_KEY, DB_PATH
├── .gitignore
└── docs/plans/
```

## Key Reference Info

- **Matrix homeserver:** `https://matrix.beeper.com/`
- **Access token location:** `~/Library/Application Support/BeeperTexts/account.db` → `account` table, 3rd column
- **WhatsApp room detection:** Store entries with `com.beeper.bridge_name: "whatsapp"` in their `m.bridge` state
- **Room ID format:** `!xxxxx:beeper.local`
- **Sync endpoint:** `GET /_matrix/client/v3/sync?since={next_batch}&timeout=30000`
- **Existing analysis scripts:** `/Users/braydon/projects/personal/WhatsApp Chat - The vibez (code code code)/analysis/`
- **Existing exports:** 10 zips in parent directory, parsed by `whatsapp_analysis.py`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/vibez/__init__.py`
- Create: `backend/tests/conftest.py`
- Create: `.env.example`
- Create: `.gitignore`

**Step 1: Create Python backend pyproject.toml**

```toml
[project]
name = "vibez-monitor"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "httpx>=0.27",
    "anthropic>=0.43",
    "python-dotenv>=1.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "pytest-httpx>=0.35",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

**Step 2: Create backend/vibez/__init__.py**

```python
"""Vibez Monitor — WhatsApp attention firewall."""
```

**Step 3: Create backend/tests/conftest.py**

```python
import os
import sqlite3
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def tmp_db(tmp_path):
    """Provide a temporary SQLite database path."""
    return tmp_path / "test_vibez.db"
```

**Step 4: Create .env.example**

```
ANTHROPIC_API_KEY=sk-ant-...
VIBEZ_DB_PATH=./vibez.db
BEEPER_DB_PATH=~/Library/Application Support/BeeperTexts/account.db
MATRIX_HOMESERVER=https://matrix.beeper.com
LOG_DIR=~/Library/Logs/vibez-monitor
```

**Step 5: Create .gitignore**

```
.env
vibez.db
vibez.db-*
__pycache__/
*.pyc
.pytest_cache/
node_modules/
.next/
dist/
*.egg-info/
```

**Step 6: Install Python dependencies**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && pip install -e "backend[dev]"`
Expected: Successful install of httpx, anthropic, python-dotenv, pytest

**Step 7: Commit**

```bash
git add backend/pyproject.toml backend/vibez/__init__.py backend/tests/conftest.py .env.example .gitignore
git commit -m "feat: project scaffolding with Python backend structure"
```

---

### Task 2: SQLite Database Schema

**Files:**
- Create: `backend/vibez/db.py`
- Create: `backend/tests/test_db.py`

**Step 1: Write the failing test**

```python
# backend/tests/test_db.py
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
    init_db(tmp_db)  # Should not raise
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
        (
            "$event1",
            "!room1:beeper.local",
            "The vibez (code code code)",
            "@user1:beeper.local",
            "Harper",
            "check out this repo",
            1708300000000,
            '{"type": "m.room.message"}',
        ),
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
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && python -m pytest backend/tests/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'vibez.db'`

**Step 3: Write the implementation**

```python
# backend/vibez/db.py
"""SQLite database schema and connection management."""

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
        "MoneyCommand",
        "Amplifier",
        "driftdriver",
        "workgraph",
        "speedrift",
        "home-automation",
    ],
    "alert_threshold": 7,
}


def get_connection(db_path: str | Path) -> sqlite3.Connection:
    """Get a SQLite connection with WAL mode enabled."""
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: str | Path) -> None:
    """Initialize the database schema. Idempotent."""
    conn = get_connection(db_path)
    conn.executescript(SCHEMA)
    # Seed default value config if empty
    cursor = conn.execute("SELECT COUNT(*) FROM value_config")
    if cursor.fetchone()[0] == 0:
        import json

        for key, value in DEFAULT_VALUE_CONFIG.items():
            conn.execute(
                "INSERT OR IGNORE INTO value_config (key, value) VALUES (?, ?)",
                (key, json.dumps(value)),
            )
    conn.commit()
    conn.close()
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/braydon/projects/personal/vibez-monitor && python -m pytest backend/tests/test_db.py -v`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add backend/vibez/db.py backend/tests/test_db.py
git commit -m "feat: SQLite database schema with messages, classifications, reports"
```

---

### Task 3: Configuration Module

**Files:**
- Create: `backend/vibez/config.py`
- Create: `backend/tests/test_config.py`
- Create: `.env` (from .env.example, not committed)

**Step 1: Write the failing test**

```python
# backend/tests/test_config.py
import os
from unittest.mock import patch
from vibez.config import Config


def test_config_loads_from_env(tmp_path):
    env = {
        "ANTHROPIC_API_KEY": "sk-test-key",
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
        "MATRIX_HOMESERVER": "https://matrix.beeper.com",
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = Config.from_env()
    assert cfg.anthropic_api_key == "sk-test-key"
    assert cfg.matrix_homeserver == "https://matrix.beeper.com"


def test_config_defaults(tmp_path):
    env = {
        "ANTHROPIC_API_KEY": "sk-test-key",
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = Config.from_env()
    assert cfg.matrix_homeserver == "https://matrix.beeper.com"
    assert cfg.sync_timeout_ms == 30000
    assert cfg.classifier_model == "claude-sonnet-4-6"
    assert cfg.synthesis_model == "claude-sonnet-4-6"


def test_read_beeper_token(tmp_path):
    """Test reading access token from a mock Beeper DB."""
    import sqlite3

    mock_db = tmp_path / "account.db"
    conn = sqlite3.connect(str(mock_db))
    conn.execute(
        "CREATE TABLE account (user_id TEXT, device_id TEXT, token TEXT, homeserver TEXT)"
    )
    conn.execute(
        "INSERT INTO account VALUES ('user', 'dev', 'syt_test_token', 'https://matrix.beeper.com/')"
    )
    conn.commit()
    conn.close()

    from vibez.config import read_beeper_token

    token = read_beeper_token(mock_db)
    assert token == "syt_test_token"
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'vibez.config'`

**Step 3: Write the implementation**

```python
# backend/vibez/config.py
"""Configuration management. Reads from env vars and Beeper DB."""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path


def read_beeper_token(beeper_db_path: str | Path) -> str:
    """Read the Matrix access token from Beeper's local database."""
    conn = sqlite3.connect(str(beeper_db_path))
    cursor = conn.execute("SELECT token FROM account LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    if not row:
        raise ValueError(f"No account found in Beeper DB: {beeper_db_path}")
    return row[0]


@dataclass
class Config:
    anthropic_api_key: str
    db_path: Path
    matrix_homeserver: str = "https://matrix.beeper.com"
    matrix_access_token: str = ""
    beeper_db_path: Path = field(
        default_factory=lambda: Path.home()
        / "Library/Application Support/BeeperTexts/account.db"
    )
    sync_timeout_ms: int = 30000
    classifier_model: str = "claude-sonnet-4-6"
    synthesis_model: str = "claude-sonnet-4-6"
    synthesis_hour: int = 6
    log_dir: Path = field(
        default_factory=lambda: Path.home() / "Library/Logs/vibez-monitor"
    )

    @classmethod
    def from_env(cls) -> Config:
        """Load configuration from environment variables."""
        from dotenv import load_dotenv

        load_dotenv()

        db_path = Path(os.environ.get("VIBEZ_DB_PATH", "./vibez.db"))
        beeper_db = Path(
            os.environ.get(
                "BEEPER_DB_PATH",
                str(Path.home() / "Library/Application Support/BeeperTexts/account.db"),
            )
        )

        token = os.environ.get("MATRIX_ACCESS_TOKEN", "")
        if not token and beeper_db.exists():
            token = read_beeper_token(beeper_db)

        return cls(
            anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
            db_path=db_path,
            matrix_homeserver=os.environ.get(
                "MATRIX_HOMESERVER", "https://matrix.beeper.com"
            ),
            matrix_access_token=token,
            beeper_db_path=beeper_db,
            sync_timeout_ms=int(os.environ.get("SYNC_TIMEOUT_MS", "30000")),
            classifier_model=os.environ.get("CLASSIFIER_MODEL", "claude-sonnet-4-6"),
            synthesis_model=os.environ.get("SYNTHESIS_MODEL", "claude-sonnet-4-6"),
            synthesis_hour=int(os.environ.get("SYNTHESIS_HOUR", "6")),
            log_dir=Path(
                os.environ.get(
                    "LOG_DIR", str(Path.home() / "Library/Logs/vibez-monitor")
                )
            ),
        )
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_config.py -v`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add backend/vibez/config.py backend/tests/test_config.py
git commit -m "feat: configuration module with Beeper token reading"
```

---

### Task 4: Matrix Sync Service

**Files:**
- Create: `backend/vibez/matrix_sync.py`
- Create: `backend/tests/test_matrix_sync.py`
- Create: `backend/scripts/run_sync.py`

**Step 1: Write the failing tests**

```python
# backend/tests/test_matrix_sync.py
import json
import pytest
from vibez.matrix_sync import (
    parse_message_event,
    filter_whatsapp_rooms,
    extract_messages_from_sync,
)


def test_parse_message_event():
    event = {
        "event_id": "$abc123",
        "sender": "@whatsapp_1234:beeper.local",
        "type": "m.room.message",
        "origin_server_ts": 1708300000000,
        "content": {
            "msgtype": "m.text",
            "body": "check out this repo https://github.com/foo/bar",
        },
    }
    msg = parse_message_event(event, "!room1:beeper.local", "The vibez")
    assert msg["id"] == "$abc123"
    assert msg["body"] == "check out this repo https://github.com/foo/bar"
    assert msg["room_name"] == "The vibez"
    assert msg["timestamp"] == 1708300000000


def test_parse_message_event_skips_non_text():
    event = {
        "event_id": "$abc",
        "sender": "@u:b",
        "type": "m.room.message",
        "origin_server_ts": 1000,
        "content": {"msgtype": "m.image", "body": "photo.jpg"},
    }
    msg = parse_message_event(event, "!r:b", "room")
    assert msg is not None  # Still capture, body is the fallback text


def test_parse_message_event_extracts_sender_name():
    event = {
        "event_id": "$ev1",
        "sender": "@whatsapp_1234:beeper.local",
        "type": "m.room.message",
        "origin_server_ts": 1000,
        "content": {
            "msgtype": "m.text",
            "body": "hello",
            "com.beeper.sender_name": "Harper",
        },
    }
    msg = parse_message_event(event, "!r:b", "room")
    assert msg["sender_name"] == "Harper"


def test_filter_whatsapp_rooms():
    rooms_state = {
        "!wa_room:beeper.local": {
            "state": {
                "events": [
                    {
                        "type": "m.bridge",
                        "content": {"com.beeper.bridge_name": "whatsapp"},
                    },
                    {
                        "type": "m.room.name",
                        "content": {"name": "The vibez (code code code)"},
                    },
                ]
            }
        },
        "!slack_room:beeper.local": {
            "state": {
                "events": [
                    {
                        "type": "m.bridge",
                        "content": {"com.beeper.bridge_name": "slackgo"},
                    }
                ]
            }
        },
    }
    wa_rooms = filter_whatsapp_rooms(rooms_state)
    assert "!wa_room:beeper.local" in wa_rooms
    assert "!slack_room:beeper.local" not in wa_rooms
    assert wa_rooms["!wa_room:beeper.local"] == "The vibez (code code code)"


def test_extract_messages_from_sync():
    known_rooms = {"!r1:b": "The vibez"}
    sync_response = {
        "rooms": {
            "join": {
                "!r1:b": {
                    "timeline": {
                        "events": [
                            {
                                "event_id": "$e1",
                                "sender": "@u:b",
                                "type": "m.room.message",
                                "origin_server_ts": 1000,
                                "content": {"msgtype": "m.text", "body": "hello"},
                            },
                            {
                                "event_id": "$e2",
                                "sender": "@u:b",
                                "type": "m.room.member",
                                "origin_server_ts": 1001,
                                "content": {"membership": "join"},
                            },
                        ]
                    }
                },
                "!unknown:b": {
                    "timeline": {
                        "events": [
                            {
                                "event_id": "$e3",
                                "sender": "@u:b",
                                "type": "m.room.message",
                                "origin_server_ts": 1002,
                                "content": {"msgtype": "m.text", "body": "ignored"},
                            }
                        ]
                    }
                },
            }
        }
    }
    messages = extract_messages_from_sync(sync_response, known_rooms)
    assert len(messages) == 1
    assert messages[0]["id"] == "$e1"
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_matrix_sync.py -v`
Expected: FAIL — `ModuleNotFoundError`

**Step 3: Write the implementation**

```python
# backend/vibez/matrix_sync.py
"""Matrix sync service — connects to Beeper's Matrix API and captures WhatsApp messages."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from vibez.config import Config
from vibez.db import get_connection, init_db

logger = logging.getLogger("vibez.sync")


def parse_message_event(
    event: dict[str, Any], room_id: str, room_name: str
) -> dict[str, Any] | None:
    """Parse a Matrix m.room.message event into our message format."""
    if event.get("type") != "m.room.message":
        return None

    content = event.get("content", {})
    sender_name = content.get("com.beeper.sender_name", "")
    if not sender_name:
        # Fall back to sender ID, strip the Matrix parts
        sender_id = event.get("sender", "")
        sender_name = sender_id.split(":")[0].lstrip("@").replace("whatsapp_", "+")

    return {
        "id": event["event_id"],
        "room_id": room_id,
        "room_name": room_name,
        "sender_id": event.get("sender", ""),
        "sender_name": sender_name,
        "body": content.get("body", ""),
        "timestamp": event.get("origin_server_ts", 0),
        "raw_event": json.dumps(event),
    }


def filter_whatsapp_rooms(
    rooms_state: dict[str, Any],
) -> dict[str, str]:
    """Given room join state from a sync response, return {room_id: room_name} for WhatsApp rooms."""
    wa_rooms: dict[str, str] = {}
    for room_id, room_data in rooms_state.items():
        state_events = room_data.get("state", {}).get("events", [])
        is_whatsapp = False
        room_name = room_id
        for ev in state_events:
            if ev.get("type") == "m.bridge":
                bridge_name = ev.get("content", {}).get("com.beeper.bridge_name", "")
                if bridge_name == "whatsapp":
                    is_whatsapp = True
            if ev.get("type") == "m.room.name":
                room_name = ev.get("content", {}).get("name", room_id)
        if is_whatsapp:
            wa_rooms[room_id] = room_name
    return wa_rooms


def extract_messages_from_sync(
    sync_response: dict[str, Any], known_rooms: dict[str, str]
) -> list[dict[str, Any]]:
    """Extract messages from a sync response, filtering to known WhatsApp rooms."""
    messages = []
    join_rooms = sync_response.get("rooms", {}).get("join", {})
    for room_id, room_data in join_rooms.items():
        if room_id not in known_rooms:
            continue
        room_name = known_rooms[room_id]
        timeline_events = room_data.get("timeline", {}).get("events", [])
        for event in timeline_events:
            msg = parse_message_event(event, room_id, room_name)
            if msg is not None:
                messages.append(msg)
    return messages


def save_messages(db_path: Path, messages: list[dict[str, Any]]) -> int:
    """Save messages to the database. Returns count of new messages inserted."""
    if not messages:
        return 0
    conn = get_connection(db_path)
    count = 0
    for msg in messages:
        try:
            conn.execute(
                """INSERT OR IGNORE INTO messages
                   (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    msg["id"],
                    msg["room_id"],
                    msg["room_name"],
                    msg["sender_id"],
                    msg["sender_name"],
                    msg["body"],
                    msg["timestamp"],
                    msg["raw_event"],
                ),
            )
            if conn.total_changes:
                count += 1
        except Exception:
            logger.exception("Failed to insert message %s", msg["id"])
    conn.commit()
    conn.close()
    return count


def load_sync_token(db_path: Path) -> str | None:
    """Load the next_batch sync token from the database."""
    conn = get_connection(db_path)
    cursor = conn.execute("SELECT value FROM sync_state WHERE key = 'next_batch'")
    row = cursor.fetchone()
    conn.close()
    return row[0] if row else None


def save_sync_token(db_path: Path, token: str) -> None:
    """Save the next_batch sync token."""
    conn = get_connection(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('next_batch', ?)",
        (token,),
    )
    conn.commit()
    conn.close()


async def sync_loop(config: Config, on_messages=None) -> None:
    """Main sync loop. Long-polls the Matrix server continuously.

    Args:
        config: Application configuration.
        on_messages: Optional callback(messages) called when new messages arrive.
                     Used to trigger classification.
    """
    init_db(config.db_path)
    known_rooms: dict[str, str] = {}
    next_batch = load_sync_token(config.db_path)
    backoff = 1

    headers = {"Authorization": f"Bearer {config.matrix_access_token}"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        while True:
            try:
                params: dict[str, Any] = {"timeout": config.sync_timeout_ms}
                if next_batch:
                    params["since"] = next_batch
                else:
                    # Initial sync: use a filter to limit data
                    params["filter"] = json.dumps(
                        {
                            "room": {
                                "timeline": {"limit": 1},
                                "state": {"lazy_load_members": True},
                            }
                        }
                    )

                resp = await client.get(
                    f"{config.matrix_homeserver}/_matrix/client/v3/sync",
                    params=params,
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()

                # Discover WhatsApp rooms from state events
                join_rooms = data.get("rooms", {}).get("join", {})
                new_wa_rooms = filter_whatsapp_rooms(join_rooms)
                if new_wa_rooms:
                    known_rooms.update(new_wa_rooms)
                    logger.info("WhatsApp rooms: %s", list(known_rooms.values()))

                # Extract and save messages
                messages = extract_messages_from_sync(data, known_rooms)
                if messages:
                    saved = save_messages(config.db_path, messages)
                    logger.info("Saved %d new messages (of %d)", saved, len(messages))
                    if on_messages and saved > 0:
                        await on_messages(messages)

                # Update sync token
                new_batch = data.get("next_batch", "")
                if new_batch:
                    next_batch = new_batch
                    save_sync_token(config.db_path, next_batch)

                backoff = 1  # Reset on success

            except httpx.HTTPStatusError as e:
                logger.error("HTTP error %s: %s", e.response.status_code, e)
                if e.response.status_code == 429:
                    retry_after = int(
                        e.response.headers.get("Retry-After", str(backoff))
                    )
                    await asyncio.sleep(retry_after)
                else:
                    await asyncio.sleep(min(backoff, 300))
                    backoff = min(backoff * 2, 300)
            except (httpx.ConnectError, httpx.ReadTimeout) as e:
                logger.warning("Connection issue: %s. Retrying in %ds", e, backoff)
                await asyncio.sleep(min(backoff, 300))
                backoff = min(backoff * 2, 300)
            except Exception:
                logger.exception("Unexpected error in sync loop")
                await asyncio.sleep(min(backoff, 300))
                backoff = min(backoff * 2, 300)
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_matrix_sync.py -v`
Expected: All 5 tests PASS

**Step 5: Create the run script**

```python
# backend/scripts/run_sync.py
"""Entry point for the Matrix sync service."""

import asyncio
import logging
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.matrix_sync import sync_loop
from vibez.classifier import classify_messages


async def main():
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "sync.log"),
        ],
    )

    logger = logging.getLogger("vibez.sync")
    logger.info("Starting vibez-monitor sync service")
    logger.info("Database: %s", config.db_path)

    async def on_messages(messages):
        await classify_messages(config, messages)

    await sync_loop(config, on_messages=on_messages)


if __name__ == "__main__":
    asyncio.run(main())
```

**Step 6: Commit**

```bash
git add backend/vibez/matrix_sync.py backend/tests/test_matrix_sync.py backend/scripts/run_sync.py
git commit -m "feat: Matrix sync service with WhatsApp room filtering"
```

---

### Task 5: Sonnet Classifier

**Files:**
- Create: `backend/vibez/classifier.py`
- Create: `backend/tests/test_classifier.py`

**Step 1: Write the failing tests**

```python
# backend/tests/test_classifier.py
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from vibez.classifier import build_classify_prompt, parse_classification, classify_messages


def test_build_classify_prompt():
    message = {
        "sender_name": "Sam Schillace",
        "room_name": "The vibez (code code code)",
        "body": "check out this new amplifier feature for context management",
    }
    value_config = {
        "topics": ["agentic-architecture", "practical-tools"],
        "projects": ["Amplifier", "driftdriver"],
    }
    context_messages = [
        {"sender_name": "Harper", "body": "anyone tried the new claude model?"},
    ]
    prompt = build_classify_prompt(message, value_config, context_messages)
    assert "Sam Schillace" in prompt
    assert "amplifier" in prompt.lower()
    assert "The vibez (code code code)" in prompt
    assert "Harper" in prompt


def test_parse_classification_valid():
    raw = json.dumps(
        {
            "relevance_score": 9,
            "topics": ["agentic-arch", "context-management"],
            "entities": ["amplifier"],
            "contribution_flag": True,
            "contribution_hint": "Your driftdriver work relates to this",
            "alert_level": "hot",
        }
    )
    result = parse_classification(raw)
    assert result["relevance_score"] == 9
    assert result["contribution_flag"] is True
    assert result["alert_level"] == "hot"


def test_parse_classification_clamps_score():
    raw = json.dumps(
        {
            "relevance_score": 15,
            "topics": [],
            "entities": [],
            "contribution_flag": False,
            "contribution_hint": "",
            "alert_level": "none",
        }
    )
    result = parse_classification(raw)
    assert result["relevance_score"] == 10


def test_parse_classification_invalid_json():
    result = parse_classification("not json at all")
    assert result["relevance_score"] == 0
    assert result["alert_level"] == "none"
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_classifier.py -v`
Expected: FAIL — `ModuleNotFoundError`

**Step 3: Write the implementation**

```python
# backend/vibez/classifier.py
"""Sonnet-based message classifier for the attention firewall."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection

logger = logging.getLogger("vibez.classifier")

CLASSIFY_SYSTEM = """You are a message classifier for Braydon's WhatsApp attention firewall.
You classify messages by relevance to Braydon's interests and identify contribution opportunities.
Always respond with valid JSON only. No prose, no markdown fences."""

CLASSIFY_TEMPLATE = """Classify this WhatsApp message.

Braydon's interest topics: {topics}
Braydon's active projects: {projects}

Message:
  From: {sender_name}
  Group: {room_name}
  Text: {body}

Recent thread context:
{context}

Respond with JSON:
{{
  "relevance_score": <0-10, how relevant to Braydon's interests>,
  "topics": [<topic tags from the message>],
  "entities": [<tools, repos, concepts, people mentioned>],
  "contribution_flag": <true if Braydon could add value>,
  "contribution_hint": "<if flagged, why and what could he contribute>",
  "alert_level": "<'hot' if needs attention now, 'digest' if include in daily summary, 'none' if low value>"
}}"""


def build_classify_prompt(
    message: dict[str, Any],
    value_config: dict[str, Any],
    context_messages: list[dict[str, Any]] | None = None,
) -> str:
    """Build the classification prompt for a single message."""
    context_lines = ""
    if context_messages:
        for cm in context_messages[-3:]:
            context_lines += f"  {cm.get('sender_name', '?')}: {cm.get('body', '')}\n"
    if not context_lines:
        context_lines = "  (no recent context)"

    return CLASSIFY_TEMPLATE.format(
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        sender_name=message.get("sender_name", "Unknown"),
        room_name=message.get("room_name", "Unknown"),
        body=message.get("body", ""),
        context=context_lines,
    )


def parse_classification(raw: str) -> dict[str, Any]:
    """Parse classifier output JSON, with safe defaults on failure."""
    defaults = {
        "relevance_score": 0,
        "topics": [],
        "entities": [],
        "contribution_flag": False,
        "contribution_hint": "",
        "alert_level": "none",
    }
    try:
        # Strip markdown fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        cleaned = cleaned.strip()

        data = json.loads(cleaned)
        result = {**defaults, **data}
        result["relevance_score"] = max(0, min(10, int(result["relevance_score"])))
        if result["alert_level"] not in ("hot", "digest", "none"):
            result["alert_level"] = "none"
        result["contribution_flag"] = bool(result["contribution_flag"])
        return result
    except (json.JSONDecodeError, KeyError, ValueError):
        logger.warning("Failed to parse classification: %s", raw[:200])
        return defaults


def load_value_config(db_path: Path) -> dict[str, Any]:
    """Load value configuration from the database."""
    conn = get_connection(db_path)
    cursor = conn.execute("SELECT key, value FROM value_config")
    config = {}
    for key, value in cursor.fetchall():
        config[key] = json.loads(value)
    conn.close()
    return config


def get_recent_context(db_path: Path, room_id: str, before_ts: int, limit: int = 3) -> list[dict]:
    """Get recent messages in the same room for thread context."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT sender_name, body FROM messages
           WHERE room_id = ? AND timestamp < ?
           ORDER BY timestamp DESC LIMIT ?""",
        (room_id, before_ts, limit),
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"sender_name": r[0], "body": r[1]} for r in reversed(rows)]


def save_classification(db_path: Path, message_id: str, classification: dict[str, Any]) -> None:
    """Save a classification result to the database."""
    conn = get_connection(db_path)
    conn.execute(
        """INSERT OR REPLACE INTO classifications
           (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            message_id,
            classification["relevance_score"],
            json.dumps(classification["topics"]),
            json.dumps(classification["entities"]),
            classification["contribution_flag"],
            classification["contribution_hint"],
            classification["alert_level"],
        ),
    )
    conn.commit()
    conn.close()


def write_hot_alert(db_path: Path, message: dict, classification: dict) -> None:
    """Write a hot alert to a JSON file the dashboard can watch."""
    alerts_path = db_path.parent / "hot_alerts.json"
    alerts = []
    if alerts_path.exists():
        try:
            alerts = json.loads(alerts_path.read_text())
        except json.JSONDecodeError:
            alerts = []
    alerts.append(
        {
            "message_id": message["id"],
            "sender_name": message.get("sender_name", ""),
            "room_name": message.get("room_name", ""),
            "body": message.get("body", ""),
            "timestamp": message.get("timestamp", 0),
            "relevance_score": classification["relevance_score"],
            "contribution_hint": classification.get("contribution_hint", ""),
        }
    )
    # Keep last 50 alerts
    alerts = alerts[-50:]
    alerts_path.write_text(json.dumps(alerts, indent=2))


async def classify_messages(config: Config, messages: list[dict[str, Any]]) -> None:
    """Classify a batch of messages using Sonnet."""
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    value_cfg = load_value_config(config.db_path)

    for msg in messages:
        try:
            context = get_recent_context(config.db_path, msg["room_id"], msg["timestamp"])
            prompt = build_classify_prompt(msg, value_cfg, context)

            response = client.messages.create(
                model=config.classifier_model,
                max_tokens=256,
                system=CLASSIFY_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
            raw_text = response.content[0].text
            classification = parse_classification(raw_text)

            save_classification(config.db_path, msg["id"], classification)

            if classification["alert_level"] == "hot":
                write_hot_alert(config.db_path, msg, classification)
                logger.info(
                    "HOT ALERT: %s in %s (score=%d): %s",
                    msg.get("sender_name"),
                    msg.get("room_name"),
                    classification["relevance_score"],
                    classification.get("contribution_hint", ""),
                )
            else:
                logger.debug(
                    "Classified %s: score=%d level=%s",
                    msg["id"],
                    classification["relevance_score"],
                    classification["alert_level"],
                )
        except Exception:
            logger.exception("Failed to classify message %s", msg.get("id"))
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_classifier.py -v`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add backend/vibez/classifier.py backend/tests/test_classifier.py
git commit -m "feat: Sonnet classifier with value-based relevance scoring"
```

---

### Task 6: Daily Synthesis Agent

**Files:**
- Create: `backend/vibez/synthesis.py`
- Create: `backend/tests/test_synthesis.py`
- Create: `backend/scripts/run_synthesis.py`

**Step 1: Write the failing tests**

```python
# backend/tests/test_synthesis.py
import json
from vibez.db import init_db, get_connection
from vibez.synthesis import build_synthesis_prompt, parse_synthesis_report, get_day_messages


def _seed_messages(db_path, count=5):
    """Seed test messages with classifications."""
    init_db(db_path)
    conn = get_connection(db_path)
    for i in range(count):
        conn.execute(
            """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                f"$ev{i}",
                "!r1:b",
                "The vibez",
                f"@u{i}:b",
                f"User{i}",
                f"Message about topic {i}",
                1708300000000 + i * 60000,
                "{}",
            ),
        )
        conn.execute(
            """INSERT INTO classifications
               (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                f"$ev{i}",
                5 + i,
                json.dumps(["agentic-arch"]),
                json.dumps(["amplifier"]),
                i % 2 == 0,
                "hint" if i % 2 == 0 else "",
                "digest" if i > 2 else "none",
            ),
        )
    conn.commit()
    conn.close()


def test_get_day_messages(tmp_db):
    _seed_messages(tmp_db)
    messages = get_day_messages(tmp_db, 1708300000000, 1708300000000 + 300000)
    assert len(messages) == 5
    assert messages[0]["sender_name"] == "User0"
    assert messages[0]["relevance_score"] == 5


def test_build_synthesis_prompt(tmp_db):
    _seed_messages(tmp_db)
    messages = get_day_messages(tmp_db, 1708300000000, 1708300000000 + 300000)
    value_config = {"topics": ["agentic-arch"], "projects": ["Amplifier"]}
    prompt = build_synthesis_prompt(messages, value_config, previous_briefing=None)
    assert "5 messages" in prompt
    assert "The vibez" in prompt


def test_parse_synthesis_report_valid():
    raw = json.dumps(
        {
            "briefing": [
                {
                    "title": "Amplifier discussion",
                    "participants": ["Sam", "Harper"],
                    "insights": "New context management approach",
                    "links": [],
                }
            ],
            "contributions": [
                {
                    "thread": "Amplifier discussion",
                    "why": "Your driftdriver relates",
                    "action": "Share your approach",
                }
            ],
            "trends": {"emerging": ["projector"], "fading": []},
            "links": [],
        }
    )
    report = parse_synthesis_report(raw)
    assert len(report["briefing"]) == 1
    assert len(report["contributions"]) == 1


def test_parse_synthesis_report_invalid():
    report = parse_synthesis_report("not json")
    assert report["briefing"] == []
    assert report["contributions"] == []
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_synthesis.py -v`
Expected: FAIL — `ModuleNotFoundError`

**Step 3: Write the implementation**

```python
# backend/vibez/synthesis.py
"""Daily synthesis agent — generates morning briefings and contribution maps."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection, init_db

logger = logging.getLogger("vibez.synthesis")

SYNTHESIS_SYSTEM = """You are Braydon's daily intelligence analyst for the Vibez WhatsApp ecosystem.
You produce structured daily briefings that help him stay engaged with minimal reading.
Always respond with valid JSON only. No prose outside the JSON structure."""

SYNTHESIS_TEMPLATE = """Generate today's briefing from {msg_count} messages across {group_count} groups.

Braydon's interest topics: {topics}
Braydon's active projects: {projects}

{previous_context}

Messages (chronological, with classifications):
{messages_block}

Respond with JSON:
{{
  "briefing": [
    {{
      "title": "<thread/topic title>",
      "participants": ["<key people>"],
      "insights": "<1-2 sentence summary of what happened/was decided>",
      "links": ["<any URLs shared>"]
    }}
  ],
  "contributions": [
    {{
      "thread": "<which thread>",
      "why": "<why Braydon's knowledge is relevant>",
      "action": "<specific suggested action>"
    }}
  ],
  "trends": {{
    "emerging": ["<new topics gaining traction>"],
    "fading": ["<topics losing steam>"],
    "shifts": "<1 sentence on what changed this week>"
  }},
  "links": [
    {{
      "url": "<link>",
      "title": "<what it is>",
      "category": "<tool|repo|article|discussion>",
      "relevance": "<why it matters to Braydon>"
    }}
  ]
}}

Focus on the top 3-5 most important threads. Be specific about contribution opportunities."""


def get_day_messages(
    db_path: Path, start_ts: int, end_ts: int
) -> list[dict[str, Any]]:
    """Get all messages with classifications for a time range."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp,
                  c.relevance_score, c.topics, c.entities,
                  c.contribution_flag, c.contribution_hint, c.alert_level
           FROM messages m
           LEFT JOIN classifications c ON m.id = c.message_id
           WHERE m.timestamp >= ? AND m.timestamp < ?
           ORDER BY m.timestamp ASC""",
        (start_ts, end_ts),
    )
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "id": r[0],
            "room_name": r[1],
            "sender_name": r[2],
            "body": r[3],
            "timestamp": r[4],
            "relevance_score": r[5] or 0,
            "topics": json.loads(r[6]) if r[6] else [],
            "entities": json.loads(r[7]) if r[7] else [],
            "contribution_flag": bool(r[8]),
            "contribution_hint": r[9] or "",
            "alert_level": r[10] or "none",
        }
        for r in rows
    ]


def build_synthesis_prompt(
    messages: list[dict[str, Any]],
    value_config: dict[str, Any],
    previous_briefing: str | None = None,
) -> str:
    """Build the synthesis prompt from classified messages."""
    groups = set(m["room_name"] for m in messages)

    messages_block = ""
    for m in messages:
        ts = datetime.fromtimestamp(m["timestamp"] / 1000).strftime("%H:%M")
        score = m.get("relevance_score", 0)
        flag = " [CONTRIBUTION OPP]" if m.get("contribution_flag") else ""
        messages_block += (
            f"  [{ts}] [{m['room_name']}] {m['sender_name']} (rel={score}{flag}): "
            f"{m['body'][:500]}\n"
        )

    previous_context = ""
    if previous_briefing:
        previous_context = (
            f"Yesterday's key threads (for continuity):\n{previous_briefing[:1000]}\n"
        )

    return SYNTHESIS_TEMPLATE.format(
        msg_count=len(messages),
        group_count=len(groups),
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        previous_context=previous_context,
        messages_block=messages_block,
    )


def parse_synthesis_report(raw: str) -> dict[str, Any]:
    """Parse synthesis output JSON with safe defaults."""
    defaults: dict[str, Any] = {
        "briefing": [],
        "contributions": [],
        "trends": {"emerging": [], "fading": [], "shifts": ""},
        "links": [],
    }
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        data = json.loads(cleaned.strip())
        return {**defaults, **data}
    except (json.JSONDecodeError, KeyError):
        logger.warning("Failed to parse synthesis report: %s", raw[:200])
        return defaults


def get_previous_briefing(db_path: Path) -> str | None:
    """Get yesterday's briefing for continuity context."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        "SELECT briefing_json FROM daily_reports ORDER BY report_date DESC LIMIT 1"
    )
    row = cursor.fetchone()
    conn.close()
    if row and row[0]:
        try:
            data = json.loads(row[0])
            # Summarize yesterday's threads as context
            titles = [t.get("title", "") for t in data.get("briefing", [])]
            return "Previous threads: " + ", ".join(titles)
        except json.JSONDecodeError:
            pass
    return None


def save_daily_report(
    db_path: Path, report_date: str, report: dict[str, Any], briefing_md: str
) -> None:
    """Save the daily synthesis report."""
    conn = get_connection(db_path)
    conn.execute(
        """INSERT OR REPLACE INTO daily_reports
           (report_date, briefing_md, briefing_json, contributions, trends, stats)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            report_date,
            briefing_md,
            json.dumps(report.get("briefing", [])),
            json.dumps(report.get("contributions", [])),
            json.dumps(report.get("trends", {})),
            json.dumps(report.get("links", [])),
        ),
    )
    conn.commit()
    conn.close()


def render_briefing_markdown(report: dict[str, Any], report_date: str) -> str:
    """Render the synthesis report as readable markdown."""
    lines = [f"# Vibez Daily Briefing — {report_date}\n"]

    if report.get("briefing"):
        lines.append("## Key Threads\n")
        for i, thread in enumerate(report["briefing"], 1):
            lines.append(f"### {i}. {thread.get('title', 'Untitled')}")
            participants = ", ".join(thread.get("participants", []))
            if participants:
                lines.append(f"**Participants:** {participants}")
            lines.append(f"\n{thread.get('insights', '')}\n")
            for link in thread.get("links", []):
                lines.append(f"- {link}")
            lines.append("")

    if report.get("contributions"):
        lines.append("## Contribution Opportunities\n")
        for c in report["contributions"]:
            lines.append(f"- **{c.get('thread', '')}**: {c.get('why', '')}")
            lines.append(f"  - Action: {c.get('action', '')}")
        lines.append("")

    trends = report.get("trends", {})
    if trends:
        lines.append("## Trends\n")
        if trends.get("emerging"):
            lines.append(f"**Emerging:** {', '.join(trends['emerging'])}")
        if trends.get("fading"):
            lines.append(f"**Fading:** {', '.join(trends['fading'])}")
        if trends.get("shifts"):
            lines.append(f"\n{trends['shifts']}")
        lines.append("")

    if report.get("links"):
        lines.append("## Links Shared\n")
        for link in report["links"]:
            lines.append(
                f"- [{link.get('title', link.get('url', ''))}]({link.get('url', '')})"
                f" ({link.get('category', '')}) — {link.get('relevance', '')}"
            )

    return "\n".join(lines)


async def run_daily_synthesis(config: Config) -> dict[str, Any]:
    """Run the daily synthesis for the last 24 hours."""
    from vibez.classifier import load_value_config

    init_db(config.db_path)

    now = datetime.now()
    start = now - timedelta(hours=24)
    start_ts = int(start.timestamp() * 1000)
    end_ts = int(now.timestamp() * 1000)
    report_date = now.strftime("%Y-%m-%d")

    messages = get_day_messages(config.db_path, start_ts, end_ts)
    if not messages:
        logger.info("No messages in the last 24 hours. Skipping synthesis.")
        return {"briefing": [], "contributions": [], "trends": {}, "links": []}

    value_cfg = load_value_config(config.db_path)
    previous = get_previous_briefing(config.db_path)
    prompt = build_synthesis_prompt(messages, value_cfg, previous)

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    response = client.messages.create(
        model=config.synthesis_model,
        max_tokens=4096,
        system=SYNTHESIS_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    raw_text = response.content[0].text
    report = parse_synthesis_report(raw_text)

    briefing_md = render_briefing_markdown(report, report_date)
    save_daily_report(config.db_path, report_date, report, briefing_md)

    logger.info(
        "Daily synthesis complete: %d threads, %d contributions",
        len(report.get("briefing", [])),
        len(report.get("contributions", [])),
    )
    return report
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_synthesis.py -v`
Expected: All 4 tests PASS

**Step 5: Create the run script**

```python
# backend/scripts/run_synthesis.py
"""Entry point for the daily synthesis agent."""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.synthesis import run_daily_synthesis


async def main():
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "synthesis.log"),
        ],
    )

    logger = logging.getLogger("vibez.synthesis")
    logger.info("Running daily synthesis")

    report = await run_daily_synthesis(config)
    logger.info("Done. Briefing threads: %d", len(report.get("briefing", [])))


if __name__ == "__main__":
    asyncio.run(main())
```

**Step 6: Commit**

```bash
git add backend/vibez/synthesis.py backend/tests/test_synthesis.py backend/scripts/run_synthesis.py
git commit -m "feat: daily synthesis agent with briefing, contributions, and trends"
```

---

### Task 7: Dashboard Scaffolding

**Files:**
- Create: `dashboard/package.json` (via create-next-app)
- Create: `dashboard/src/lib/db.ts`
- Create: `dashboard/src/app/layout.tsx`
- Create: `dashboard/src/components/Nav.tsx`

**Step 1: Scaffold Next.js app**

Run:
```bash
cd /Users/braydon/projects/personal/vibez-monitor
npx create-next-app@latest dashboard --typescript --tailwind --eslint --app --src-dir --no-import-alias --use-npm
```
Expected: Next.js project created in `dashboard/`

**Step 2: Install better-sqlite3**

Run: `cd /Users/braydon/projects/personal/vibez-monitor/dashboard && npm install better-sqlite3 && npm install -D @types/better-sqlite3`

**Step 3: Create the SQLite reader**

```typescript
// dashboard/src/lib/db.ts
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

export function getDb() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");
  return db;
}

export interface Message {
  id: string;
  room_id: string;
  room_name: string;
  sender_id: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  entities: string | null;
  contribution_flag: number | null;
  contribution_hint: string | null;
  alert_level: string | null;
}

export interface DailyReport {
  id: number;
  report_date: string;
  briefing_md: string | null;
  briefing_json: string | null;
  contributions: string | null;
  trends: string | null;
  stats: string | null;
  generated_at: string | null;
}

export function getMessages(opts: {
  limit?: number;
  offset?: number;
  room?: string;
  minRelevance?: number;
  contributionOnly?: boolean;
}): Message[] {
  const db = getDb();
  let query = `
    SELECT m.*, c.relevance_score, c.topics, c.entities,
           c.contribution_flag, c.contribution_hint, c.alert_level
    FROM messages m
    LEFT JOIN classifications c ON m.id = c.message_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (opts.room) {
    query += " AND m.room_name = ?";
    params.push(opts.room);
  }
  if (opts.minRelevance) {
    query += " AND c.relevance_score >= ?";
    params.push(opts.minRelevance);
  }
  if (opts.contributionOnly) {
    query += " AND c.contribution_flag = 1";
  }

  query += " ORDER BY m.timestamp DESC LIMIT ? OFFSET ?";
  params.push(opts.limit || 50, opts.offset || 0);

  const rows = db.prepare(query).all(...params) as Message[];
  db.close();
  return rows;
}

export function getLatestReport(): DailyReport | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 1")
    .get() as DailyReport | undefined;
  db.close();
  return row || null;
}

export function getReport(date: string): DailyReport | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM daily_reports WHERE report_date = ?")
    .get(date) as DailyReport | undefined;
  db.close();
  return row || null;
}

export function getRooms(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT DISTINCT room_name FROM messages ORDER BY room_name")
    .all() as { room_name: string }[];
  db.close();
  return rows.map((r) => r.room_name);
}

export function getValueConfig(): Record<string, unknown> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM value_config").all() as {
    key: string;
    value: string;
  }[];
  db.close();
  const config: Record<string, unknown> = {};
  for (const row of rows) {
    config[row.key] = JSON.parse(row.value);
  }
  return config;
}
```

**Step 4: Create the Nav component**

```tsx
// dashboard/src/components/Nav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Live Feed" },
  { href: "/briefing", label: "Briefing" },
  { href: "/contribute", label: "Contribute" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950 px-6 py-3">
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <span className="text-lg font-semibold text-zinc-100">
          vibez-monitor
        </span>
        <div className="flex gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                pathname === link.href
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
```

**Step 5: Update layout.tsx**

Replace the generated `dashboard/src/app/layout.tsx`:

```tsx
// dashboard/src/app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "vibez-monitor",
  description: "WhatsApp attention firewall for the Vibez ecosystem",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-zinc-950 text-zinc-100`}>
        <Nav />
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
```

**Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat: Next.js dashboard scaffolding with SQLite reader and nav"
```

---

### Task 8: Dashboard — Live Feed Page

**Files:**
- Create: `dashboard/src/app/page.tsx`
- Create: `dashboard/src/app/api/messages/route.ts`
- Create: `dashboard/src/components/MessageCard.tsx`
- Create: `dashboard/src/components/RelevanceBadge.tsx`

**Step 1: Create the API route**

```typescript
// dashboard/src/app/api/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getMessages, getRooms } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = parseInt(params.get("limit") || "50");
  const offset = parseInt(params.get("offset") || "0");
  const room = params.get("room") || undefined;
  const minRelevance = params.get("minRelevance")
    ? parseInt(params.get("minRelevance")!)
    : undefined;
  const contributionOnly = params.get("contributionOnly") === "true";

  const messages = getMessages({ limit, offset, room, minRelevance, contributionOnly });
  const rooms = getRooms();

  return NextResponse.json({ messages, rooms });
}
```

**Step 2: Create the RelevanceBadge component**

```tsx
// dashboard/src/components/RelevanceBadge.tsx
export function RelevanceBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) return null;
  const color =
    score >= 8
      ? "bg-red-900/50 text-red-300 border-red-800"
      : score >= 5
        ? "bg-amber-900/50 text-amber-300 border-amber-800"
        : "bg-zinc-800/50 text-zinc-400 border-zinc-700";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-mono ${color}`}>
      {score}
    </span>
  );
}
```

**Step 3: Create the MessageCard component**

```tsx
// dashboard/src/components/MessageCard.tsx
import { RelevanceBadge } from "./RelevanceBadge";

interface Props {
  message: {
    id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
    topics: string | null;
    contribution_flag: number | null;
    contribution_hint: string | null;
    alert_level: string | null;
  };
}

export function MessageCard({ message }: Props) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = new Date(message.timestamp).toLocaleDateString();
  const topics = message.topics ? JSON.parse(message.topics) : [];
  const borderColor =
    message.alert_level === "hot"
      ? "border-l-red-500"
      : message.alert_level === "digest"
        ? "border-l-amber-500"
        : "border-l-zinc-700";

  return (
    <div className={`border-l-2 ${borderColor} rounded-r-lg bg-zinc-900 p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-200">
              {message.sender_name}
            </span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
              {message.room_name}
            </span>
            <span className="text-xs text-zinc-500">
              {date} {time}
            </span>
            <RelevanceBadge score={message.relevance_score} />
          </div>
          <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">
            {message.body}
          </p>
          {message.contribution_flag === 1 && message.contribution_hint && (
            <div className="mt-2 rounded bg-emerald-950/50 border border-emerald-800 px-3 py-1.5 text-xs text-emerald-300">
              Contribution opportunity: {message.contribution_hint}
            </div>
          )}
          {topics.length > 0 && (
            <div className="mt-2 flex gap-1">
              {topics.map((t: string) => (
                <span
                  key={t}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 4: Create the Live Feed page**

```tsx
// dashboard/src/app/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { MessageCard } from "@/components/MessageCard";

interface Message {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  contribution_flag: number | null;
  contribution_hint: string | null;
  alert_level: string | null;
}

export default function LiveFeed() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [filter, setFilter] = useState({ room: "", minRelevance: 0, contributionOnly: false });
  const [loading, setLoading] = useState(true);

  const fetchMessages = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.room) params.set("room", filter.room);
    if (filter.minRelevance) params.set("minRelevance", String(filter.minRelevance));
    if (filter.contributionOnly) params.set("contributionOnly", "true");

    const res = await fetch(`/api/messages?${params}`);
    const data = await res.json();
    setMessages(data.messages);
    setRooms(data.rooms);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 10_000);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Live Feed</h1>
        <select
          className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-300"
          value={filter.room}
          onChange={(e) => setFilter((f) => ({ ...f, room: e.target.value }))}
        >
          <option value="">All groups</option>
          {rooms.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select
          className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-300"
          value={filter.minRelevance}
          onChange={(e) => setFilter((f) => ({ ...f, minRelevance: parseInt(e.target.value) }))}
        >
          <option value={0}>All relevance</option>
          <option value={3}>3+</option>
          <option value={5}>5+</option>
          <option value={7}>7+</option>
          <option value={9}>9+</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={filter.contributionOnly}
            onChange={(e) => setFilter((f) => ({ ...f, contributionOnly: e.target.checked }))}
            className="rounded border-zinc-600"
          />
          Contributions only
        </label>
      </div>

      {loading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : messages.length === 0 ? (
        <div className="text-zinc-500">No messages yet. Start the sync service to begin capturing.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((msg) => (
            <MessageCard key={msg.id} message={msg} />
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add dashboard/src/
git commit -m "feat: live feed page with message cards, filters, and auto-refresh"
```

---

### Task 9: Dashboard — Briefing, Contribute, Settings Pages

**Files:**
- Create: `dashboard/src/app/briefing/page.tsx`
- Create: `dashboard/src/app/api/briefing/route.ts`
- Create: `dashboard/src/components/BriefingView.tsx`
- Create: `dashboard/src/app/contribute/page.tsx`
- Create: `dashboard/src/app/api/contributions/route.ts`
- Create: `dashboard/src/components/ContributionCard.tsx`
- Create: `dashboard/src/app/settings/page.tsx`
- Create: `dashboard/src/app/api/settings/route.ts`

**Step 1: Briefing API route**

```typescript
// dashboard/src/app/api/briefing/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getLatestReport, getReport } from "@/lib/db";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  const report = date ? getReport(date) : getLatestReport();
  return NextResponse.json({ report });
}
```

**Step 2: BriefingView component**

```tsx
// dashboard/src/components/BriefingView.tsx
interface Thread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

interface Props {
  briefing_md: string | null;
  briefing_json: string | null;
  trends: string | null;
  report_date: string;
}

export function BriefingView({ briefing_md, briefing_json, trends, report_date }: Props) {
  const threads: Thread[] = briefing_json ? JSON.parse(briefing_json) : [];
  const trendData = trends ? JSON.parse(trends) : {};

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">
        Briefing — {report_date}
      </h2>

      {threads.length === 0 ? (
        <p className="text-zinc-500">No briefing available for this date.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {threads.map((thread, i) => (
            <div key={i} className="rounded-lg bg-zinc-900 p-4">
              <h3 className="font-medium text-zinc-200">{thread.title}</h3>
              <p className="mt-1 text-xs text-zinc-500">
                {thread.participants.join(", ")}
              </p>
              <p className="mt-2 text-sm text-zinc-300">{thread.insights}</p>
              {thread.links.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {thread.links.map((link, j) => (
                    <a
                      key={j}
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:underline"
                    >
                      {link}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}

          {(trendData.emerging?.length > 0 || trendData.fading?.length > 0) && (
            <div className="rounded-lg bg-zinc-900 p-4">
              <h3 className="font-medium text-zinc-200">Trends</h3>
              {trendData.emerging?.length > 0 && (
                <p className="mt-1 text-sm text-emerald-400">
                  Emerging: {trendData.emerging.join(", ")}
                </p>
              )}
              {trendData.fading?.length > 0 && (
                <p className="mt-1 text-sm text-zinc-500">
                  Fading: {trendData.fading.join(", ")}
                </p>
              )}
              {trendData.shifts && (
                <p className="mt-2 text-sm text-zinc-300">{trendData.shifts}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Briefing page**

```tsx
// dashboard/src/app/briefing/page.tsx
"use client";

import { useEffect, useState } from "react";
import { BriefingView } from "@/components/BriefingView";

interface Report {
  report_date: string;
  briefing_md: string | null;
  briefing_json: string | null;
  contributions: string | null;
  trends: string | null;
}

export default function BriefingPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/briefing")
      .then((r) => r.json())
      .then((data) => {
        setReport(data.report);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="text-zinc-500">Loading...</div>;
  if (!report) return <div className="text-zinc-500">No briefings yet. Run the synthesis agent to generate one.</div>;

  return (
    <BriefingView
      briefing_md={report.briefing_md}
      briefing_json={report.briefing_json}
      trends={report.trends}
      report_date={report.report_date}
    />
  );
}
```

**Step 4: Contributions API route**

```typescript
// dashboard/src/app/api/contributions/route.ts
import { NextResponse } from "next/server";
import { getMessages } from "@/lib/db";

export async function GET() {
  const messages = getMessages({ contributionOnly: true, limit: 100 });
  return NextResponse.json({ contributions: messages });
}
```

**Step 5: ContributionCard component**

```tsx
// dashboard/src/components/ContributionCard.tsx
import { RelevanceBadge } from "./RelevanceBadge";

interface Props {
  message: {
    id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
    contribution_hint: string | null;
  };
}

export function ContributionCard({ message }: Props) {
  const date = new Date(message.timestamp).toLocaleDateString();
  return (
    <div className="rounded-lg border border-emerald-900 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
          {message.room_name}
        </span>
        <div className="flex items-center gap-2">
          <RelevanceBadge score={message.relevance_score} />
          <span className="text-xs text-zinc-500">{date}</span>
        </div>
      </div>
      <p className="mt-2 text-sm text-zinc-300">
        <span className="font-medium">{message.sender_name}:</span>{" "}
        {message.body.slice(0, 200)}
        {message.body.length > 200 && "..."}
      </p>
      {message.contribution_hint && (
        <div className="mt-3 rounded bg-emerald-950/50 border border-emerald-800 px-3 py-2 text-sm text-emerald-300">
          {message.contribution_hint}
        </div>
      )}
    </div>
  );
}
```

**Step 6: Contribute page**

```tsx
// dashboard/src/app/contribute/page.tsx
"use client";

import { useEffect, useState } from "react";
import { ContributionCard } from "@/components/ContributionCard";

interface Message {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  contribution_hint: string | null;
}

export default function ContributePage() {
  const [contributions, setContributions] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/contributions")
      .then((r) => r.json())
      .then((data) => {
        setContributions(data.contributions);
        setLoading(false);
      });
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Contribution Opportunities</h1>
      {loading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : contributions.length === 0 ? (
        <div className="text-zinc-500">No contribution opportunities yet.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {contributions.map((msg) => (
            <ContributionCard key={msg.id} message={msg} />
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 7: Settings API route**

```typescript
// dashboard/src/app/api/settings/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getValueConfig } from "@/lib/db";
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

export async function GET() {
  const config = getValueConfig();
  return NextResponse.json({ config });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const db = new Database(DB_PATH);
  for (const [key, value] of Object.entries(body)) {
    db.prepare("INSERT OR REPLACE INTO value_config (key, value) VALUES (?, ?)").run(
      key,
      JSON.stringify(value)
    );
  }
  db.close();
  return NextResponse.json({ ok: true });
}
```

**Step 8: Settings page**

```tsx
// dashboard/src/app/settings/page.tsx
"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topicsInput, setTopicsInput] = useState("");
  const [projectsInput, setProjectsInput] = useState("");
  const [threshold, setThreshold] = useState(7);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data.config);
        setTopicsInput((data.config.topics as string[] || []).join(", "));
        setProjectsInput((data.config.projects as string[] || []).join(", "));
        setThreshold((data.config.alert_threshold as number) || 7);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const topics = topicsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const projects = projectsInput.split(",").map((t) => t.trim()).filter(Boolean);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics, projects, alert_threshold: threshold }),
    });
    setSaving(false);
  };

  if (loading) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      <div className="flex flex-col gap-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">
            Interest Topics
          </label>
          <textarea
            className="w-full rounded bg-zinc-800 p-3 text-sm text-zinc-200"
            rows={3}
            value={topicsInput}
            onChange={(e) => setTopicsInput(e.target.value)}
            placeholder="agentic-architecture, practical-tools, business-ai"
          />
          <p className="mt-1 text-xs text-zinc-500">Comma-separated topic tags</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">
            Your Projects
          </label>
          <textarea
            className="w-full rounded bg-zinc-800 p-3 text-sm text-zinc-200"
            rows={2}
            value={projectsInput}
            onChange={(e) => setProjectsInput(e.target.value)}
            placeholder="MoneyCommand, Amplifier, driftdriver"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Comma-separated project names the classifier matches against
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">
            Hot Alert Threshold
          </label>
          <input
            type="range"
            min={1}
            max={10}
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value))}
            className="w-full"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Relevance score {threshold}+ triggers hot alerts
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
```

**Step 9: Commit**

```bash
git add dashboard/src/
git commit -m "feat: briefing, contribute, and settings pages"
```

---

### Task 10: launchd Service Configuration

**Files:**
- Create: `launchd/com.vibez-monitor.sync.plist`
- Create: `launchd/com.vibez-monitor.synthesis.plist`

**Step 1: Create the sync service plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.vibez-monitor.sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>/Users/braydon/projects/personal/vibez-monitor/backend/scripts/run_sync.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/braydon/projects/personal/vibez-monitor</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/braydon/Library/Logs/vibez-monitor/sync-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/braydon/Library/Logs/vibez-monitor/sync-stderr.log</string>
</dict>
</plist>
```

**Step 2: Create the synthesis cron plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.vibez-monitor.synthesis</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>/Users/braydon/projects/personal/vibez-monitor/backend/scripts/run_synthesis.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/braydon/projects/personal/vibez-monitor</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/braydon/Library/Logs/vibez-monitor/synthesis-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/braydon/Library/Logs/vibez-monitor/synthesis-stderr.log</string>
</dict>
</plist>
```

**Step 3: Commit**

```bash
git add launchd/
git commit -m "feat: launchd plists for sync service and daily synthesis cron"
```

**Step 4: Install services** (manual, after everything works)

```bash
mkdir -p ~/Library/Logs/vibez-monitor
cp launchd/com.vibez-monitor.sync.plist ~/Library/LaunchAgents/
cp launchd/com.vibez-monitor.synthesis.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.sync.plist
launchctl load ~/Library/LaunchAgents/com.vibez-monitor.synthesis.plist
```

---

### Task 11: Backfill from Existing Exports

**Files:**
- Create: `backend/scripts/backfill.py`

This task imports the 10 existing WhatsApp zip exports into the database, then runs the classifier on them. Reuses the parsing logic from the existing `whatsapp_analysis.py`.

**Step 1: Write the backfill script**

```python
# backend/scripts/backfill.py
"""Import existing WhatsApp chat exports into the vibez-monitor database."""

import asyncio
import json
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.db import init_db, get_connection
from vibez.classifier import classify_messages

CONTROL_CHARS = {"\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\ufeff"}
TS_RE = re.compile(
    r"^\s*[\u200e\u200f\u202a\u202b\u202c\ufeff]*\[(\d{1,2}/\d{1,2}/\d{2,4}),\s+([0-9:]+\s*[AP]M)\]\s+(.*)$"
)

EXPORT_DIR = Path(
    "/Users/braydon/projects/personal/WhatsApp Chat - The vibez (code code code)"
)


def normalize_text(value: str) -> str:
    value = value.replace("\u202f", " ").replace("\u00a0", " ")
    return "".join(ch for ch in value if ch not in CONTROL_CHARS)


def parse_dt(date_str: str, time_str: str) -> datetime | None:
    time_str = time_str.replace("\u202f", " ").replace("\u00a0", " ").strip()
    fmts = ["%m/%d/%y %I:%M:%S %p", "%m/%d/%y %I:%M %p"]
    for fmt in fmts:
        try:
            return datetime.strptime(f"{date_str} {time_str}", fmt)
        except ValueError:
            pass
    return None


def parse_and_import(zip_path: Path, db_path: Path) -> list[dict]:
    """Parse a WhatsApp export zip and insert messages into the database."""
    group_name = zip_path.stem.replace("WhatsApp Chat - ", "").strip()

    with zipfile.ZipFile(zip_path) as zf:
        chat_files = [n for n in zf.namelist() if n.lower().endswith("_chat.txt")]
        if not chat_files:
            return []
        chat_text = zf.read(chat_files[0]).decode("utf-8", errors="replace")

    messages = []
    current = None
    detected_group = None

    def finalize(entry):
        nonlocal detected_group
        if not entry:
            return
        dt, sender, body = entry
        sender = normalize_text(sender).strip().lstrip("~").strip() if sender else None
        body = normalize_text(body).strip()
        if detected_group is None and sender and "end-to-end encrypted" in body.lower():
            detected_group = sender
            return
        if sender is None or sender == (detected_group or group_name):
            return  # Skip system messages
        msg_id = f"$backfill_{zip_path.stem}_{len(messages)}"
        ts_ms = int(dt.timestamp() * 1000) if dt else 0
        messages.append({
            "id": msg_id,
            "room_id": f"!backfill_{group_name.replace(' ', '_')}",
            "room_name": detected_group or group_name,
            "sender_id": f"@backfill_{sender.replace(' ', '_')}",
            "sender_name": sender,
            "body": body,
            "timestamp": ts_ms,
            "raw_event": json.dumps({"source": "backfill", "zip": zip_path.name}),
        })

    for raw_line in chat_text.splitlines():
        line = normalize_text(raw_line)
        match = TS_RE.match(line)
        if match:
            finalize(current)
            date_str, time_str, rest = match.groups()
            dt = parse_dt(date_str, time_str)
            sender = None
            body = rest
            if ": " in rest:
                sender, body = rest.split(": ", 1)
            current = (dt, sender, body)
        elif current:
            dt, sender, body = current
            current = (dt, sender, f"{body}\n{line}".strip())

    finalize(current)

    # Insert into database
    conn = get_connection(db_path)
    inserted = 0
    for msg in messages:
        try:
            conn.execute(
                """INSERT OR IGNORE INTO messages
                   (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (msg["id"], msg["room_id"], msg["room_name"], msg["sender_id"],
                 msg["sender_name"], msg["body"], msg["timestamp"], msg["raw_event"]),
            )
            inserted += 1
        except Exception as e:
            print(f"  Error inserting: {e}")
    conn.commit()
    conn.close()
    print(f"  {zip_path.name}: {inserted} messages imported")
    return messages


async def main():
    config = Config.from_env()
    init_db(config.db_path)

    zip_paths = sorted(EXPORT_DIR.glob("*.zip"))
    print(f"Found {len(zip_paths)} export zips")

    all_messages = []
    for zp in zip_paths:
        msgs = parse_and_import(zp, config.db_path)
        all_messages.extend(msgs)

    print(f"\nTotal: {len(all_messages)} messages imported")

    # Classify in batches
    print("\nClassifying messages (this may take a while and cost ~$1-2)...")
    batch_size = 10
    for i in range(0, len(all_messages), batch_size):
        batch = all_messages[i : i + batch_size]
        await classify_messages(config, batch)
        done = min(i + batch_size, len(all_messages))
        print(f"  Classified {done}/{len(all_messages)}")

    print("\nBackfill complete!")


if __name__ == "__main__":
    asyncio.run(main())
```

**Step 2: Commit**

```bash
git add backend/scripts/backfill.py
git commit -m "feat: backfill script to import existing WhatsApp exports"
```

---

## Execution Order

1. **Task 1** — Scaffolding (no dependencies)
2. **Task 2** — Database schema (depends on 1)
3. **Task 3** — Config module (depends on 1)
4. **Task 4** — Matrix sync (depends on 2, 3)
5. **Task 5** — Classifier (depends on 2, 3)
6. **Task 6** — Synthesis (depends on 2, 3, 5)
7. **Task 7** — Dashboard scaffolding (depends on 2)
8. **Task 8** — Live feed page (depends on 7)
9. **Task 9** — Remaining dashboard pages (depends on 7, 8)
10. **Task 10** — launchd setup (depends on 4, 6)
11. **Task 11** — Backfill (depends on 2, 3, 5)

Tasks 4+5 can run in parallel. Tasks 7-9 can run in parallel with 4-6. Task 11 can run as soon as 5 is done.
