import json
from vibez.db import init_db, get_connection
from vibez.synthesis import build_synthesis_prompt, parse_synthesis_report, get_day_messages


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
        "briefing": [{"title": "Amplifier discussion", "participants": ["Sam", "Harper"],
                       "insights": "New context management approach", "links": []}],
        "contributions": [{"thread": "Amplifier discussion",
                           "why": "Your driftdriver relates", "action": "Share your approach"}],
        "trends": {"emerging": ["projector"], "fading": []},
        "links": [],
    })
    report = parse_synthesis_report(raw)
    assert len(report["briefing"]) == 1
    assert len(report["contributions"]) == 1


def test_parse_synthesis_report_invalid():
    report = parse_synthesis_report("not json")
    assert report["briefing"] == []
    assert report["contributions"] == []
