import json
import sqlite3
import threading
import time
from types import SimpleNamespace

from vibez.db import get_connection, init_db
from vibez.wisdom import (
    _best_topic_summary,
    _chunk_messages,
    _parse_json_payload,
    _topic_slug,
    classify_chunk,
    run_wisdom_extraction,
)


class _FakeAnthropic:
    def __init__(self, api_key: str):
        self.api_key = api_key


class _FakeMessagesAPI:
    def __init__(self, response):
        self.response = response
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return self.response


class _FakeClient:
    def __init__(self, response):
        self.messages = _FakeMessagesAPI(response)


def test_topic_slug_normalizes_names():
    assert _topic_slug("Agent Frameworks") == "agent-frameworks"
    assert _topic_slug("  MCP / Protocol  ") == "mcp-protocol"


def test_chunk_messages_groups_by_room_and_time():
    messages = [
        {"id": "1", "room_name": "A", "timestamp": 1_000},
        {"id": "2", "room_name": "A", "timestamp": 2_000},
        {"id": "3", "room_name": "A", "timestamp": 9_000_000},
        {"id": "4", "room_name": "B", "timestamp": 9_100_000},
    ]

    chunks = _chunk_messages(messages, window_hours=1)

    assert [[msg["id"] for msg in chunk] for chunk in chunks] == [
        ["1", "2"],
        ["3"],
        ["4"],
    ]


def test_parse_json_payload_accepts_fenced_or_wrapped_json():
    wrapped = 'Here you go:\n```json\n[{"topic":"Agent Frameworks"}]\n```\n'
    assert _parse_json_payload(wrapped) == [{"topic": "Agent Frameworks"}]

    prose = 'Result: {"items":[{"topic":"MCP Protocol"}]} thanks.'
    assert _parse_json_payload(prose) == {"items": [{"topic": "MCP Protocol"}]}


def test_classify_chunk_reads_text_from_later_blocks_and_sets_strict_system_prompt():
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text=""),
            SimpleNamespace(
                type="text",
                text='```json\n[{"topic":"Agent Frameworks","title":"Useful stacks"}]\n```',
            ),
        ]
    )
    client = _FakeClient(response)

    items = classify_chunk(
        client,
        "claude-test",
        [{"room_name": "AGI House", "sender_name": "Alice", "body": "Useful stacks", "timestamp": 1}],
    )

    assert items == [{"topic": "Agent Frameworks", "title": "Useful stacks"}]
    assert "strict JSON array only" in client.messages.last_kwargs["system"]


def test_best_topic_summary_prefers_non_empty_summary_then_title():
    assert _best_topic_summary(
        [
            {"title": "Lower confidence", "summary": "Fallback", "confidence": 0.4},
            {"title": "Higher confidence", "summary": "Preferred summary", "confidence": 0.9},
        ]
    ) == "Preferred summary"
    assert _best_topic_summary([{"title": "Title only", "summary": "", "confidence": 0.2}]) == "Title only"


def test_run_wisdom_extraction_writes_topics_items_and_recommendations(tmp_db, monkeypatch):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    rows = [
        ("m1", "room-a", "AGI House", "u1", "Alice", "Detailed notes on agent frameworks and MCP adapters", 1_000, "{}"),
        ("m2", "room-a", "AGI House", "u2", "Bob", "More agent frameworks discussion with context windows", 2_000, "{}"),
        ("m3", "room-b", "Paia", "u3", "Cara", "Benchmarks for vector databases and agent frameworks", 3_000, "{}"),
        ("m4", "room-b", "Paia", "u4", "Dan", "Practical MCP protocol implementation details", 4_000, "{}"),
    ]
    conn.executemany(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    conn.close()

    classifications = [
        [
            {
                "knowledge_type": "stack",
                "topic": "Agent Frameworks",
                "title": "Teams are converging on agent frameworks",
                "summary": "Discussion centered on practical orchestration stacks.",
                "contributors": ["Alice", "Bob"],
                "links": ["https://example.com/frameworks"],
                "confidence": 0.9,
            }
        ],
        [
            {
                "knowledge_type": "architecture",
                "topic": "MCP Protocol",
                "title": "MCP adapters need clean boundaries",
                "summary": "Boundary management came up as an architectural constraint.",
                "contributors": ["Alice", "Bob", "Dan"],
                "links": ["https://example.com/mcp"],
                "confidence": 0.8,
            }
        ],
    ]

    def fake_classify_chunk(_client, _model, _chunk):
        return classifications.pop(0)

    monkeypatch.setattr("vibez.wisdom.Anthropic", _FakeAnthropic)
    monkeypatch.setattr("vibez.wisdom.classify_chunk", fake_classify_chunk)
    monkeypatch.setattr(
        "vibez.wisdom.synthesize_topic",
        lambda _client, _model, topic_name, _items: f"{topic_name} consensus",
    )

    result = run_wisdom_extraction(tmp_db, api_key="test-key", full_rebuild=True)

    assert result["chunks_processed"] == 2
    assert result["items_extracted"] == 2
    assert result["topics_created"] == 2
    assert result["recommendations_created"] == 1

    conn = get_connection(tmp_db)
    topics = conn.execute(
        "SELECT slug, summary, message_count, contributor_count FROM wisdom_topics ORDER BY slug"
    ).fetchall()
    items = conn.execute(
        "SELECT knowledge_type, title, source_links, contributors FROM wisdom_items ORDER BY id"
    ).fetchall()
    recs = conn.execute(
        "SELECT strength, reason FROM wisdom_recommendations"
    ).fetchall()
    watermark = conn.execute(
        "SELECT value FROM sync_state WHERE key = 'wisdom_last_run'"
    ).fetchone()
    conn.close()

    assert topics == [
        ("agent-frameworks", "Agent Frameworks consensus", 2, 2),
        ("mcp-protocol", "MCP Protocol consensus", 2, 3),
    ]
    assert items[0][0] == "stack"
    assert items[0][1] == "Teams are converging on agent frameworks"
    assert json.loads(items[0][2]) == ["https://example.com/frameworks"]
    assert json.loads(items[0][3]) == ["Alice", "Bob"]
    assert len(recs) == 1
    assert recs[0][0] == 0.4
    assert "Bob" in recs[0][1]
    assert watermark == ("4000",)


def test_run_wisdom_extraction_falls_back_to_best_item_summary_when_topic_synthesis_is_empty(tmp_db, monkeypatch):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("m1", "room-a", "AGI House", "u1", "Alice", "Detailed notes on agents", 1_000, "{}"),
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr("vibez.wisdom.Anthropic", _FakeAnthropic)
    monkeypatch.setattr(
        "vibez.wisdom.classify_chunk",
        lambda _client, _model, _chunk: [
            {
                "knowledge_type": "opinion",
                "topic": "Agent Reviews",
                "title": "Review loops matter",
                "summary": "People kept coming back to review loops as the thing that catches bad model output.",
                "contributors": ["Alice"],
                "links": [],
                "confidence": 0.7,
            }
        ],
    )
    monkeypatch.setattr("vibez.wisdom.synthesize_topic", lambda *_args, **_kwargs: "")

    run_wisdom_extraction(tmp_db, api_key="test-key", full_rebuild=True)

    conn = get_connection(tmp_db)
    summary = conn.execute("SELECT summary FROM wisdom_topics WHERE slug = 'agent-reviews'").fetchone()
    conn.close()

    assert summary == (
        "People kept coming back to review loops as the thing that catches bad model output.",
    )


def test_run_wisdom_extraction_retries_locked_writes(tmp_db, monkeypatch):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("m1", "room-a", "AGI House", "u1", "Alice", "Detailed notes on agents", 1_000, "{}"),
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr("vibez.wisdom.Anthropic", _FakeAnthropic)
    monkeypatch.setattr(
        "vibez.wisdom.classify_chunk",
        lambda _client, _model, _chunk: [
            {
                "knowledge_type": "opinion",
                "topic": "Agent Reviews",
                "title": "Review loops matter",
                "summary": "Review loops catch bad model output before it lands.",
                "contributors": ["Alice"],
                "links": [],
                "confidence": 0.7,
            }
        ],
    )
    monkeypatch.setattr("vibez.wisdom.synthesize_topic", lambda *_args, **_kwargs: "Agent Reviews consensus")
    monkeypatch.setattr("vibez.wisdom.WISDOM_WRITE_RETRY_DELAY_SECONDS", 0.05)
    monkeypatch.setattr("vibez.wisdom.WISDOM_WRITE_BUSY_TIMEOUT_MS", 10)

    lock_conn = sqlite3.connect(str(tmp_db), timeout=0.0, check_same_thread=False)
    lock_conn.execute("PRAGMA journal_mode=WAL")
    lock_conn.execute("BEGIN IMMEDIATE")

    result_holder: dict[str, object] = {}
    error_holder: dict[str, Exception] = {}

    def run_job() -> None:
        try:
            result_holder["result"] = run_wisdom_extraction(tmp_db, api_key="test-key", full_rebuild=True)
        except Exception as exc:  # pragma: no cover - assertion below surfaces details
            error_holder["error"] = exc

    worker = threading.Thread(target=run_job)
    worker.start()
    time.sleep(0.1)
    lock_conn.rollback()
    lock_conn.close()
    worker.join(timeout=5)

    assert "error" not in error_holder
    assert result_holder["result"] == {
        "chunks_processed": 1,
        "items_extracted": 1,
        "topics_created": 1,
        "recommendations_created": 0,
    }
