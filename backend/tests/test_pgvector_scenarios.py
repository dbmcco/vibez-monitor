from vibez import chat_agent
from vibez.db import get_connection, init_db


def test_pgvector_failure_falls_back_to_sqlite_keyword_search(monkeypatch, tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES ('$m2', '!r2:b.l', 'AGI', '@u2:b.l', 'Taylor', 'Discussing retrieval and arcs', 1708300000000, '{}')"""
    )
    conn.execute(
        """INSERT INTO classifications (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level)
           VALUES ('$m2', 7, '["retrieval"]', '[]', 0, '', 'none')"""
    )
    conn.commit()
    conn.close()

    def broken_hybrid(*_args, **_kwargs):
        raise RuntimeError("pg unavailable")

    monkeypatch.setattr(chat_agent, "search_hybrid_pgvector", broken_hybrid)

    rows = chat_agent.search_messages(
        tmp_db,
        "retrieval arcs",
        lookback_days=3650,
        pg_url="postgresql://localhost/test",
    )

    assert rows
    assert rows[0]["sender_name"] == "Taylor"
