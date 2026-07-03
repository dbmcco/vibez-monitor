from types import SimpleNamespace

from backend.scripts import run_sync, run_sync_once


def test_run_sync_uses_pgvector_url_for_indexing_when_configured():
    config = SimpleNamespace(
        pgvector_url="postgresql://pgvector.local/vibez",
        database_url="postgresql://core.local/vibez",
    )

    assert run_sync.resolve_pgvector_index_url(config) == "postgresql://pgvector.local/vibez"


def test_run_sync_once_falls_back_to_database_url_for_indexing():
    config = SimpleNamespace(
        pgvector_url="",
        database_url="postgresql://core.local/vibez",
    )

    assert run_sync_once.resolve_pgvector_index_url(config) == "postgresql://core.local/vibez"
