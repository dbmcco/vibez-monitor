"""Postgres database connection management."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("vibez.db")

_pool: Any = None
_pool_url: str = ""

DEFAULT_DATABASE_URL = "postgresql://braydon@localhost:5432/vibez_monitor"

DEFAULT_VALUE_CONFIG = {
    "topics": [
        "agentic-architecture", "multi-agent-systems", "context-management",
        "orchestration", "practical-tools", "repos", "business-ai", "productivity",
    ],
    "projects": [
        "core-platform", "automation-tooling", "knowledge-system",
        "analytics-pipeline", "integration-workflows", "ops-infrastructure",
    ],
    "alert_threshold": 7,
}


_connection: Any = None

try:
    import psycopg as _psycopg
except ImportError:
    import sys as _sys
    _saved = list(_sys.path)
    _sys.path = [p for p in _sys.path if not (p.endswith("backend") and "site-packages" not in p)]
    import psycopg as _psycopg
    _sys.path[:] = _saved

try:
    from psycopg_pool import ConnectionPool as _ConnectionPool
except ImportError:
    import sys as _sys2
    _saved2 = list(_sys2.path)
    _sys2.path = [p for p in _sys2.path if not (p.endswith("backend") and "site-packages" not in p)]
    from psycopg_pool import ConnectionPool as _ConnectionPool
    _sys2.path[:] = _saved2


def _get_pool() -> Any:
    global _pool, _pool_url
    if _pool is not None:
        return _pool
    url = os.environ.get("VIBEZ_DATABASE_URL") or os.environ.get("VIBEZ_PGVECTOR_URL") or DEFAULT_DATABASE_URL
    _pool = _ConnectionPool(url, min_size=1, max_size=8, open=True)
    _pool_url = url
    logger.info("Postgres pool created (min=1, max=8) for %s", url.split("@")[-1] if "@" in url else url)
    return _pool


class _PoolConnection:
    """Wraps a psycopg connection so .close() returns it to the pool and
    .commit() / .execute() / .fetchone() / .fetchall() work transparently."""

    def __init__(self, raw: Any, pool: Any) -> None:
        self._raw = raw
        self._pool = pool

    def __getattr__(self, name: str) -> Any:
        return getattr(self._raw, name)

    def close(self) -> None:
        try:
            self._raw.execute("ROLLBACK")
        except Exception:
            pass
        try:
            self._pool.putconn(self._raw)
        except Exception:
            try:
                self._raw.close()
            except Exception:
                pass

    def commit(self) -> None:
        self._raw.execute("COMMIT")

    def rollback(self) -> None:
        self._raw.execute("ROLLBACK")

    def execute(self, sql: str, params: Any = None) -> Any:
        if params is not None:
            return self._raw.execute(sql, params)
        return self._raw.execute(sql)

    def executemany(self, sql: str, params: Any) -> Any:
        return self._raw.executemany(sql, params)

    def executescript(self, _sql: str) -> None:
        # SQLite compat — split into statements
        for stmt in _sql.split(";"):
            stmt = stmt.strip()
            if stmt:
                self._raw.execute(stmt)

    def fetchone(self) -> Any:
        return self._raw.fetchone()

    def fetchall(self) -> Any:
        return self._raw.fetchall()

    def cursor(self) -> Any:
        return self._raw.cursor()

    def __enter__(self) -> "_PoolConnection":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def get_connection(_db_path: str | Path | None = None) -> _PoolConnection:
    """Get a connection from the Postgres pool. Call .close() to return it."""
    pool = _get_pool()
    raw = pool.getconn()
    return _PoolConnection(raw, pool)


def release_connection(conn: _PoolConnection) -> None:
    conn.close()


def init_db(_db_path: str | Path | None = None) -> None:
    """Ensure default value_config rows exist."""
    conn = get_connection()
    try:
        cnt = conn.execute("SELECT COUNT(*) FROM value_config").fetchone()[0]
        if cnt == 0:
            for key, value in DEFAULT_VALUE_CONFIG.items():
                conn.execute(
                    "INSERT INTO value_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO NOTHING",
                    (key, json.dumps(value)),
                )
            conn.commit()
    finally:
        conn.close()


def invalidate_catchup_for_date(_db_path: str | Path | None, date: str) -> None:
    """Mark catchup cache entries stale."""
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE catchup_cache SET stale = 1 WHERE start_date <= %s AND end_date >= %s",
            (date, date),
        )
        conn.commit()
    finally:
        conn.close()


def close_db_connection() -> None:
    """Close the connection pool."""
    global _pool, _pool_url
    if _pool is not None:
        _pool.close()
        _pool = None
        _pool_url = ""
        logger.info("Postgres pool closed")
