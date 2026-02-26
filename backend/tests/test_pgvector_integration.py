from vibez import chat_agent


def test_chat_search_uses_pgvector_when_configured(monkeypatch, tmp_db):
    called = {}

    def fake_hybrid(pg_url, query, lookback_days, limit, table, dimensions):
        called["pg_url"] = pg_url
        called["query"] = query
        called["lookback_days"] = lookback_days
        called["limit"] = limit
        called["table"] = table
        called["dimensions"] = dimensions
        return [{"room_name": "AGI", "sender_name": "Sam", "body": "Hit", "timestamp": 1}]

    monkeypatch.setattr(chat_agent, "search_hybrid_pgvector", fake_hybrid)

    rows = chat_agent.search_messages(
        tmp_db,
        "what changed",
        lookback_days=14,
        limit=22,
        pg_url="postgresql://localhost/test",
        pg_table="vibez_message_embeddings",
        pg_dimensions=192,
    )

    assert len(rows) == 1
    assert called["pg_url"] == "postgresql://localhost/test"
    assert called["query"] == "what changed"
    assert called["lookback_days"] == 14
    assert called["limit"] == 22
    assert called["table"] == "vibez_message_embeddings"
    assert called["dimensions"] == 192
