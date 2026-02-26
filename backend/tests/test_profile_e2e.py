import asyncio
import json
from datetime import datetime

from vibez.config import Config
from vibez.db import get_connection, init_db
from vibez.synthesis import run_daily_synthesis


class _FakeTextBlock:
    type = "text"

    def __init__(self, text: str):
        self.text = text


class _FakeResponse:
    def __init__(self, text: str):
        self.content = [_FakeTextBlock(text)]


def test_profile_e2e_synthesis_pipeline_uses_custom_subject(tmp_db, tmp_path, monkeypatch):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    now_ts = int(datetime.now().timestamp() * 1000)

    messages = [
        ("$evt-1", "!room:b", "Builders", "@a.smith:b", "A.Smith", "I can share my adapter pattern."),
        ("$evt-2", "!room:b", "Builders", "@nia:b", "Nia", "Can someone review this design today?"),
    ]
    for idx, (event_id, room_id, room_name, sender_id, sender_name, body) in enumerate(messages):
        ts = now_ts - (idx + 1) * 60_000
        conn.execute(
            """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (event_id, room_id, room_name, sender_id, sender_name, body, ts, "{}"),
        )
        conn.execute(
            """INSERT INTO classifications
               (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level, contribution_themes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event_id,
                8,
                json.dumps(["architecture"]),
                json.dumps(["adapter"]),
                1,
                "Share implementation details.",
                "digest",
                json.dumps(["architecture-review"]),
            ),
        )
    conn.commit()
    conn.close()

    captured: dict[str, str] = {}
    fake_report = json.dumps(
        {
            "daily_memo": "Adapters and review workflows are converging.",
            "conversation_arcs": [],
            "briefing": [],
            "contributions": [],
            "trends": {"emerging": ["architecture"], "fading": [], "shifts": "More review asks."},
            "links": [],
        }
    )

    class _FakeMessagesClient:
        def create(self, **kwargs):
            captured["system"] = kwargs.get("system", "")
            content = kwargs.get("messages", [{}])[0].get("content", "")
            captured["prompt"] = str(content)
            return _FakeResponse(fake_report)

    class _FakeAnthropic:
        def __init__(self, api_key: str):
            self.api_key = api_key
            self.messages = _FakeMessagesClient()

    monkeypatch.setattr("vibez.synthesis.anthropic.Anthropic", _FakeAnthropic)

    config = Config(
        anthropic_api_key="sk-test",
        db_path=tmp_db,
        subject_name="Alex",
        self_aliases=("Alex", "a.smith"),
        dossier_path=tmp_path / "missing-dossier.json",
    )

    report = asyncio.run(run_daily_synthesis(config))

    assert report["daily_memo"]
    assert "Alex" in captured.get("system", "")
    assert "RECENT MESSAGES BY ALEX" in captured.get("prompt", "")
    assert "Braydon" not in captured.get("system", "")

    conn = get_connection(tmp_db)
    row = conn.execute(
        "SELECT report_date, briefing_md FROM daily_reports ORDER BY report_date DESC LIMIT 1"
    ).fetchone()
    conn.close()
    assert row is not None
    assert row[0]
    assert row[1]
