from __future__ import annotations

from vibez import semantic_index


def test_compose_embedding_text_caps_long_documents_and_keeps_metadata():
    row = {
        "body": "agentic systems " * 400,
        "topics": '["retrieval"]',
        "entities": '["pgvector"]',
        "contribution_themes": '["search"]',
        "contribution_hint": "important thread",
        "room_name": "Show and Tell",
        "sender_name": "Nat",
    }

    text = semantic_index._compose_embedding_text(row)

    assert len(text) <= semantic_index.MAX_EMBED_TEXT_CHARS
    assert "Show and Tell" in text
    assert "Nat" in text
    assert "retrieval" in text
    assert "pgvector" in text


def test_compose_embedding_text_normalizes_html_entities_and_bom():
    row = {
        "body": "See:&nbsp; this thread \ufeff about embeddings",
        "topics": "[]",
        "entities": "[]",
        "contribution_themes": "[]",
        "contribution_hint": "",
        "room_name": "made-of-meat",
        "sender_name": "Steve",
    }

    text = semantic_index._compose_embedding_text(row)

    assert "&nbsp;" not in text
    assert "\ufeff" not in text
    assert "See:" in text


def test_compose_link_embedding_text_caps_long_documents_and_keeps_metadata():
    row = {
        "title": "Schuyler's Iran site",
        "relevance": "analysis " * 400,
        "category": "article",
        "url": "https://wiki.thirdgulfwar.com/",
        "shared_by": "Nat",
        "source_group": "Show and Tell",
        "authored_by": "Schuyler",
    }

    text = semantic_index._compose_link_embedding_text(row)

    assert len(text) <= semantic_index.MAX_EMBED_TEXT_CHARS
    assert "https://wiki.thirdgulfwar.com/" in text
    assert "Schuyler's Iran site" in text
    assert "Nat" in text
    assert "Show and Tell" in text


def test_batched_by_chars_splits_large_payloads():
    items = [
        "a" * 40000,
        "b" * 40000,
        "c" * 40000,
    ]

    batches = semantic_index._batched_by_chars(
        items,
        size=semantic_index.EMBED_BATCH_SIZE,
        max_chars=90000,
    )

    assert [len(batch) for batch in batches] == [2, 1]


def test_embed_text_uses_embedding_route(monkeypatch):
    captured: dict[str, object] = {}

    def fake_embed_texts(task_id: str, texts: list[str], *, dimensions: int | None = None):
        captured["task_id"] = task_id
        captured["texts"] = texts
        captured["dimensions"] = dimensions
        return [[0.6] * 64]

    monkeypatch.setattr(semantic_index.model_router, "embed_texts", fake_embed_texts)

    vec = semantic_index.embed_text("Agentic architecture and orchestration", dimensions=64)

    assert vec == [0.6] * 64
    assert captured == {
        "task_id": "embedding.semantic",
        "texts": ["Agentic architecture and orchestration"],
        "dimensions": 64,
    }


def test_embed_text_empty_returns_zero_vector():
    vec = semantic_index.embed_text("", dimensions=96)
    assert len(vec) == 96
    assert sum(abs(v) for v in vec) == 0


def test_index_rows_to_pgvector_executes_upsert(monkeypatch):
    captured: dict[str, object] = {}

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def executemany(self, sql, payload):
            captured["sql"] = sql
            captured["payload"] = payload

    class FakeConnection:
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
            return FakeConnection()

    monkeypatch.setattr(semantic_index, "_import_psycopg", lambda: FakePsycopg)
    monkeypatch.setattr(
        semantic_index,
        "ensure_pgvector_schema",
        lambda *_args, **_kwargs: captured.setdefault("schema_called", True),
    )
    monkeypatch.setattr(
        semantic_index,
        "embed_texts",
        lambda texts, *, dimensions=semantic_index.DEFAULT_DIMENSIONS: [
            [0.25] * dimensions for _ in texts
        ],
    )

    rows = [
        {
            "id": "m1",
            "room_id": "r1",
            "room_name": "AGI",
            "sender_id": "u1",
            "sender_name": "Sam",
            "body": "Need help with pgvector retrieval ranking",
            "timestamp": 1708300000000,
            "relevance_score": 8,
            "topics": '["retrieval"]',
            "entities": '["pgvector"]',
            "contribution_flag": 1,
            "contribution_themes": '["chat"]',
            "contribution_hint": "test",
            "alert_level": "none",
        }
    ]

    indexed = semantic_index.index_rows_to_pgvector(
        "postgresql://localhost/test",
        rows,
        table="vibez_message_embeddings",
        dimensions=128,
    )

    assert indexed == 1
    assert captured.get("schema_called") is True
    assert captured.get("committed") is True
    payload = captured.get("payload")
    assert isinstance(payload, list) and len(payload) == 1
    vector_literal = payload[0][-1]
    assert isinstance(vector_literal, str)
    assert vector_literal.startswith("[") and vector_literal.endswith("]")


def test_search_hybrid_pgvector_parses_rows(monkeypatch):
    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params):
            self.sql = sql
            self.params = params

        def fetchall(self):
            return [
                (
                    "m1",
                    "AGI",
                    "Sam",
                    "vector search result",
                    1708300000000,
                    7.0,
                    '["retrieval","chat"]',
                    "hint",
                    0.88,
                    0.21,
                )
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def cursor(self):
            return FakeCursor()

    class FakePsycopg:
        @staticmethod
        def connect(_url):
            return FakeConnection()

    monkeypatch.setattr(semantic_index, "_import_psycopg", lambda: FakePsycopg)
    monkeypatch.setattr(
        semantic_index,
        "embed_text",
        lambda _text, *, dimensions=semantic_index.DEFAULT_DIMENSIONS: [0.2] * dimensions,
    )

    rows = semantic_index.search_hybrid_pgvector(
        "postgresql://localhost/test",
        "vector retrieval",
        lookback_days=10,
        limit=10,
        table="vibez_message_embeddings",
        dimensions=128,
    )

    assert len(rows) == 1
    assert rows[0]["room_name"] == "AGI"
    assert rows[0]["topics"] == ["retrieval", "chat"]


def test_index_link_rows_to_pgvector_executes_upsert(monkeypatch):
    captured: dict[str, object] = {}

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def executemany(self, sql, payload):
            captured["sql"] = sql
            captured["payload"] = payload

    class FakeConnection:
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
            return FakeConnection()

    monkeypatch.setattr(semantic_index, "_import_psycopg", lambda: FakePsycopg)
    monkeypatch.setattr(
        semantic_index,
        "ensure_link_pgvector_schema",
        lambda *_args, **_kwargs: captured.setdefault("schema_called", True),
    )
    monkeypatch.setattr(
        semantic_index,
        "embed_texts",
        lambda texts, *, dimensions=semantic_index.DEFAULT_DIMENSIONS: [
            [0.5] * dimensions for _ in texts
        ],
    )

    rows = [
        {
            "id": 7,
            "url": "https://wiki.thirdgulfwar.com/",
            "url_hash": "abc123",
            "title": "wiki.thirdgulfwar.com",
            "category": "article",
            "relevance": "Schuyler's Iran site",
            "shared_by": "Nat",
            "source_group": "Show and Tell",
            "first_seen": "2026-04-23T12:00:00",
            "last_seen": "2026-04-23T12:05:00",
            "mention_count": 2,
            "value_score": 1.7,
            "report_date": "2026-04-23",
            "authored_by": "Schuyler",
            "pinned": 1,
        }
    ]

    indexed = semantic_index.index_link_rows_to_pgvector(
        "postgresql://localhost/test",
        rows,
        table="vibez_link_embeddings",
        dimensions=128,
    )

    assert indexed == 1
    assert captured.get("schema_called") is True
    assert captured.get("committed") is True
    payload = captured.get("payload")
    assert isinstance(payload, list) and len(payload) == 1
    assert payload[0][0] == 7
    vector_literal = payload[0][-1]
    assert isinstance(vector_literal, str)
    assert vector_literal.startswith("[") and vector_literal.endswith("]")


def test_ensure_link_pgvector_schema_avoids_concat_ws_in_generated_column(monkeypatch):
    captured: dict[str, object] = {}

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql):
            captured.setdefault("sql", []).append(sql)

    class FakeConnection:
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
            return FakeConnection()

    monkeypatch.setattr(semantic_index, "_import_psycopg", lambda: FakePsycopg)

    semantic_index.ensure_link_pgvector_schema("postgresql://localhost/test")

    create_table_sql = next(
        sql for sql in captured["sql"] if "CREATE TABLE IF NOT EXISTS" in sql
    )
    assert "concat_ws" not in create_table_sql.lower()


def test_index_link_rows_to_pgvector_coerces_blank_report_date_to_none(monkeypatch):
    captured: dict[str, object] = {}

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def executemany(self, sql, payload):
            captured["payload"] = payload

    class FakeConnection:
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
            return FakeConnection()

    monkeypatch.setattr(semantic_index, "_import_psycopg", lambda: FakePsycopg)
    monkeypatch.setattr(
        semantic_index,
        "ensure_link_pgvector_schema",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        semantic_index,
        "embed_texts",
        lambda texts, *, dimensions=semantic_index.DEFAULT_DIMENSIONS: [
            [0.5] * dimensions for _ in texts
        ],
    )

    semantic_index.index_link_rows_to_pgvector(
        "postgresql://localhost/test",
        [
            {
                "id": 9,
                "url": "https://example.com/post",
                "url_hash": "hash",
                "title": "Example",
                "category": "article",
                "relevance": "summary",
                "shared_by": "Nat",
                "source_group": "Show and Tell",
                "first_seen": "2026-04-23T12:00:00",
                "last_seen": "2026-04-23T12:05:00",
                "mention_count": 1,
                "value_score": 1.0,
                "report_date": "",
                "authored_by": "Schuyler",
                "pinned": 0,
            }
        ],
    )

    payload = captured["payload"]
    assert payload[0][12] is None


def test_index_sqlite_links_skips_batches_without_urls(tmp_db, monkeypatch):
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        semantic_index,
        "_fetch_sqlite_link_rows",
        lambda *_args, **_kwargs: captured.setdefault("fetched", True),
    )

    indexed = semantic_index.index_sqlite_links(
        tmp_db,
        "postgresql://localhost/test",
        source_messages=[{"body": "no links here"}],
    )

    assert indexed == 0
    assert captured == {}
