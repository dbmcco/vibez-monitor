import asyncio
import json
from pathlib import Path

from vibez.classifier import (
    build_classify_prompt,
    classify_messages,
    parse_classification,
    strip_contribution_intel,
)
from vibez.config import Config
from vibez.db import get_connection, init_db


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


def test_build_classify_prompt_with_custom_subject():
    message = {
        "sender_name": "Nia",
        "room_name": "Builders",
        "body": "Can someone sanity check this architecture?",
    }
    value_config = {
        "topics": ["systems"],
        "projects": ["Beacon"],
    }
    prompt = build_classify_prompt(
        message,
        value_config,
        context_messages=None,
        subject_name="Alex",
    )
    assert "Alex's interest topics" in prompt
    assert "Alex could add value" in prompt
    assert "Braydon" not in prompt


def test_parse_classification_valid():
    raw = json.dumps({
        "relevance_score": 9,
        "topics": ["agentic-arch", "context-management"],
        "entities": ["amplifier"],
        "contribution_flag": True,
        "contribution_hint": "Your driftdriver work relates to this",
        "alert_level": "hot",
    })
    result = parse_classification(raw)
    assert result["relevance_score"] == 9
    assert result["contribution_flag"] is True
    assert result["alert_level"] == "hot"


def test_parse_classification_clamps_score():
    raw = json.dumps({
        "relevance_score": 15,
        "topics": [],
        "entities": [],
        "contribution_flag": False,
        "contribution_hint": "",
        "alert_level": "none",
    })
    result = parse_classification(raw)
    assert result["relevance_score"] == 10


def test_parse_classification_invalid_json():
    result = parse_classification("not json at all")
    assert result["relevance_score"] == 0
    assert result["alert_level"] == "none"


def test_parse_classification_with_markdown_fences():
    raw = '```json\n{"relevance_score": 7, "topics": ["tools"], "entities": [], "contribution_flag": false, "contribution_hint": "", "alert_level": "digest"}\n```'
    result = parse_classification(raw)
    assert result["relevance_score"] == 7
    assert result["alert_level"] == "digest"


def test_strip_contribution_intel_zeros_personalized_fields():
    classification = {
        "relevance_score": 8,
        "topics": ["tools"],
        "entities": ["repo"],
        "contribution_flag": True,
        "contribution_themes": ["context-management"],
        "contribution_hint": "Share your framework",
        "alert_level": "hot",
    }
    sanitized = strip_contribution_intel(classification)
    assert sanitized["contribution_flag"] is False
    assert sanitized["contribution_themes"] == []
    assert sanitized["contribution_hint"] == ""
    assert sanitized["relevance_score"] == 8


def test_classify_messages_closes_anthropic_client(tmp_db, monkeypatch):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages
           (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "msg-1",
            "room-1",
            "The vibez (code code code)",
            "sender-1",
            "Ben",
            "Claude shipped another update",
            1776404042000,
            "{}",
        ),
    )
    conn.commit()
    conn.close()

    class FakeResponse:
        class Usage:
            input_tokens = 1
            output_tokens = 1

        def __init__(self):
            self.content = [type("Block", (), {"text": json.dumps({
                "relevance_score": 7,
                "topics": ["ai-models"],
                "entities": ["Claude"],
                "contribution_flag": False,
                "contribution_themes": [],
                "contribution_hint": "",
                "alert_level": "digest",
            })})()]
            self.usage = self.Usage()

    class FakeClient:
        def __init__(self):
            self.closed = False
            self.messages = self

        def create(self, **_kwargs):
            return FakeResponse()

        def close(self):
            self.closed = True

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self.close()
            return False

    fake_client = FakeClient()
    monkeypatch.setattr("vibez.classifier.anthropic.Anthropic", lambda **_kwargs: fake_client)
    monkeypatch.setattr("vibez.dossier.load_dossier", lambda _path: None)
    monkeypatch.setattr("vibez.dossier.format_dossier_for_classifier", lambda *_args, **_kwargs: "")
    monkeypatch.setattr("vibez.classifier.publish_event", lambda *_args, **_kwargs: None)

    config = Config(
        anthropic_api_key="test-key",
        db_path=tmp_db,
        dossier_path=Path(tmp_db).parent / "dossier.md",
        contribution_intel_enabled=True,
    )

    asyncio.run(
        classify_messages(
            config,
            [
                {
                    "id": "msg-1",
                    "room_id": "room-1",
                    "room_name": "The vibez (code code code)",
                    "sender_name": "Ben",
                    "body": "Claude shipped another update",
                    "timestamp": 1776404042000,
                }
            ],
        )
    )

    assert fake_client.closed is True
