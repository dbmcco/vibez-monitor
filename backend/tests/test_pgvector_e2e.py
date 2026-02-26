from vibez.db import init_db, get_connection
from vibez.semantic_index import index_sqlite_messages
from vibez import semantic_index


def test_pgvector_index_pipeline_indexes_from_sqlite(monkeypatch, tmp_db):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        """INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "$m1",
            "!r1:beeper.local",
            "AGI",
            "@u1:beeper.local",
            "Sam",
            "Need help with pgvector ranking",
            1708300000000,
            "{}",
        ),
    )
    conn.execute(
        """INSERT INTO classifications (message_id, relevance_score, topics, entities, contribution_flag, contribution_themes, contribution_hint, alert_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "$m1",
            8,
            '["retrieval"]',
            '["pgvector"]',
            1,
            '["chat"]',
            "Priority test",
            "hot",
        ),
    )
    conn.commit()
    conn.close()

    captured: dict[str, object] = {}

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def executemany(self, _sql, payload):
            captured["payload"] = payload

    class FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def cursor(self):
            return FakeCursor()

        def commit(self):
            captured["committed"] = True

    class FakePsycopg:
        @staticmethod
        def connect(_url):
            return FakeConn()

    monkeypatch.setattr(semantic_index, "_import_psycopg", lambda: FakePsycopg)
    monkeypatch.setattr(semantic_index, "ensure_pgvector_schema", lambda *_args, **_kwargs: None)

    indexed = index_sqlite_messages(
        tmp_db,
        "postgresql://localhost/test",
        table="vibez_message_embeddings",
        dimensions=128,
    )

    assert indexed == 1
    payload = captured.get("payload")
    assert isinstance(payload, list)
    assert payload[0][0] == "$m1"
    assert captured.get("committed") is True
