from __future__ import annotations

import math

import pytest

from vibez import semantic_index


def test_embed_text_deterministic_and_normalized():
    vec_a = semantic_index.embed_text("Agentic architecture and orchestration", dimensions=128)
    vec_b = semantic_index.embed_text("Agentic architecture and orchestration", dimensions=128)
    assert vec_a == vec_b
    assert len(vec_a) == 128
    norm = math.sqrt(sum(v * v for v in vec_a))
    assert norm == pytest.approx(1.0, rel=1e-6)


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

