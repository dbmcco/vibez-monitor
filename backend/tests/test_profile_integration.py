from datetime import datetime

from vibez.classifier import build_classify_prompt
from vibez.db import get_connection, init_db
from vibez.synthesis import build_synthesis_prompt, get_subject_messages


def test_profile_subject_name_flows_into_prompts():
    message = {
        "sender_name": "Nia",
        "room_name": "Builders",
        "body": "Can someone sanity check this architecture?",
        "timestamp": int(datetime.now().timestamp() * 1000),
    }
    value_config = {
        "topics": ["systems", "governance"],
        "projects": ["Beacon"],
    }

    classify_prompt = build_classify_prompt(
        message,
        value_config,
        context_messages=[{"sender_name": "Kai", "body": "what do folks think?"}],
        subject_name="Alex",
    )
    assert "Alex's interest topics" in classify_prompt
    assert "Alex could add value" in classify_prompt
    assert "Braydon" not in classify_prompt

    synthesis_prompt = build_synthesis_prompt(
        messages=[
            {
                "room_name": "Builders",
                "sender_name": "Nia",
                "body": "Can someone sanity check this architecture?",
                "timestamp": message["timestamp"],
                "relevance_score": 8,
                "contribution_flag": True,
                "contribution_themes": ["architecture-review"],
            }
        ],
        value_config=value_config,
        subject_name="Alex",
        subject_messages=[
            {"room_name": "Builders", "body": "I can share a quick schema pattern.", "timestamp": 0}
        ],
    )
    assert "Alex's interest topics" in synthesis_prompt
    assert "RECENT MESSAGES BY ALEX" in synthesis_prompt
    assert "Braydon" not in synthesis_prompt


def test_get_subject_messages_matches_aliases_case_insensitive(tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    now_ts = int(datetime.now().timestamp() * 1000)
    rows = [
        ("$1", "Builders", "Alex", "note 1", now_ts - 1_000),
        ("$2", "Builders", "A.SMITH", "note 2", now_ts - 2_000),
        ("$3", "Builders", "Taylor", "note 3", now_ts - 3_000),
    ]
    for event_id, room_name, sender_name, body, ts in rows:
        conn.execute(
            """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event_id,
                "!builders:b",
                room_name,
                f"@{sender_name.lower()}:b",
                sender_name,
                body,
                ts,
                "{}",
            ),
        )
    conn.commit()
    conn.close()

    result = get_subject_messages(
        tmp_db,
        now_ts - 10_000,
        now_ts + 1_000,
        ("alex", "a.smith"),
    )

    assert len(result) == 2
    assert {item["body"] for item in result} == {"note 1", "note 2"}
