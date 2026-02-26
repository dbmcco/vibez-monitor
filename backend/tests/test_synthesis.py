import json
from vibez.db import init_db, get_connection
from vibez.synthesis import (
    build_synthesis_prompt,
    get_day_messages,
    make_pithy_report,
    parse_synthesis_report,
)


def _seed_messages(db_path, count=5):
    init_db(db_path)
    conn = get_connection(db_path)
    for i in range(count):
        conn.execute(
            """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (f"$ev{i}", "!r1:b", "The vibez", f"@u{i}:b", f"User{i}",
             f"Message about topic {i}", 1708300000000 + i * 60000, "{}"),
        )
        conn.execute(
            """INSERT INTO classifications
               (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (f"$ev{i}", 5 + i, json.dumps(["agentic-arch"]), json.dumps(["amplifier"]),
             i % 2 == 0, "hint" if i % 2 == 0 else "", "digest" if i > 2 else "none"),
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
    raw = json.dumps({
        "daily_memo": "People moved from tool demos to governance tradeoffs.",
        "conversation_arcs": [
            {
                "title": "Agent controls",
                "participants": ["Sam", "Harper"],
                "core_exchange": "Debate around boundaries for remote execution.",
                "why_it_matters": "This will shape trust and adoption.",
                "likely_next": "More experiments with safeguards.",
                "how_to_add_value": "Share concrete guardrail patterns.",
            }
        ],
        "briefing": [{"title": "Amplifier discussion", "participants": ["Sam", "Harper"],
                       "insights": "New context management approach", "links": []}],
        "contributions": [{"thread": "Amplifier discussion",
                           "why": "Your driftdriver relates", "action": "Share your approach"}],
        "trends": {"emerging": ["projector"], "fading": []},
        "links": [],
    })
    report = parse_synthesis_report(raw)
    assert report["daily_memo"]
    assert len(report["conversation_arcs"]) == 1
    assert len(report["briefing"]) == 1
    assert len(report["contributions"]) == 1


def test_parse_synthesis_report_invalid():
    report = parse_synthesis_report("not json")
    assert report["daily_memo"] == ""
    assert report["conversation_arcs"] == []
    assert report["briefing"] == []
    assert report["contributions"] == []


def test_make_pithy_report_trims_and_limits_items():
    long_text = " ".join(["word"] * 200)
    report = {
        "daily_memo": long_text,
        "conversation_arcs": [
            {
                "title": long_text,
                "participants": ["Alice"] * 10,
                "core_exchange": long_text,
                "why_it_matters": long_text,
                "likely_next": long_text,
                "how_to_add_value": long_text,
            }
            for _ in range(8)
        ],
        "briefing": [
            {
                "title": long_text,
                "participants": ["Alice"] * 10,
                "insights": long_text,
                "links": [f"https://example.com/{i}" for i in range(8)],
            }
            for _ in range(7)
        ],
        "contributions": [
            {
                "theme": long_text,
                "type": "reply",
                "freshness": "hot",
                "channel": long_text,
                "reply_to": long_text,
                "threads": [long_text for _ in range(8)],
                "why": long_text,
                "action": long_text,
                "draft_message": long_text,
                "message_count": 42,
            }
            for _ in range(7)
        ],
        "trends": {
            "emerging": [long_text for _ in range(8)],
            "fading": [long_text for _ in range(8)],
            "shifts": long_text,
        },
        "links": [
            {
                "url": "https://example.com",
                "title": long_text,
                "category": long_text,
                "relevance": long_text,
            }
            for _ in range(12)
        ],
    }

    pithy = make_pithy_report(report)

    assert len(pithy["daily_memo"]) <= 523
    assert len(pithy["conversation_arcs"]) == 4
    assert len(pithy["conversation_arcs"][0]["participants"]) == 6
    assert len(pithy["conversation_arcs"][0]["core_exchange"]) <= 183
    assert len(pithy["conversation_arcs"][0]["how_to_add_value"]) <= 143
    assert len(pithy["briefing"]) == 5
    assert len(pithy["contributions"]) == 5
    assert len(pithy["links"]) == 10
    assert len(pithy["briefing"][0]["participants"]) == 6
    assert len(pithy["briefing"][0]["links"]) == 5
    assert len(pithy["briefing"][0]["insights"]) <= 163
    assert len(pithy["contributions"][0]["why"]) <= 143
    assert len(pithy["contributions"][0]["action"]) <= 113
    assert len(pithy["contributions"][0]["draft_message"]) <= 323
