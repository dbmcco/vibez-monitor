# ABOUTME: Link ingestion, dedup, value scoring, and retrieval.
# ABOUTME: Handles upsert with URL-hash dedup, recency-weighted scoring, and filtered queries.

"""Link ingestion, dedup, value scoring, and retrieval."""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from vibez.db import get_connection


def _url_hash(url: str) -> str:
    normalized = url.strip().rstrip("/").lower()
    return hashlib.sha256(normalized.encode()).hexdigest()


def compute_value_score(mention_count: int = 1, days_ago: float = 0) -> float:
    mention_signal = math.log2(max(1, mention_count)) + 1
    recency = math.exp(-0.05 * max(0, days_ago))
    return round(mention_signal * recency, 4)


def upsert_links(
    db_path: Path,
    links: list[dict[str, Any]],
    report_date: str,
    shared_by: str = "",
    source_group: str = "",
) -> int:
    if not links:
        return 0
    conn = get_connection(db_path)
    now = datetime.now().isoformat()
    inserted = 0
    for link in links:
        url = str(link.get("url", "")).strip()
        if not url:
            continue
        h = _url_hash(url)
        existing = conn.execute(
            "SELECT id, mention_count, first_seen FROM links WHERE url_hash = ?", (h,)
        ).fetchone()
        if existing:
            new_count = (existing[1] or 1) + 1
            days_ago = (datetime.now() - datetime.fromisoformat(existing[2])).days if existing[2] else 0
            score = compute_value_score(new_count, days_ago)
            conn.execute(
                """UPDATE links SET mention_count = ?, last_seen = ?, value_score = ?,
                   report_date = ? WHERE id = ?""",
                (new_count, now, score, report_date, existing[0]),
            )
        else:
            score = compute_value_score(1, 0)
            conn.execute(
                """INSERT INTO links (url, url_hash, title, category, relevance,
                   shared_by, source_group, first_seen, last_seen, mention_count,
                   value_score, report_date)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (url, h, link.get("title", ""), link.get("category", ""),
                 link.get("relevance", ""), shared_by, source_group,
                 now, now, score, report_date),
            )
            inserted += 1
        # Sync FTS index for this row
        _sync_fts_row(conn, h)
    conn.commit()
    conn.close()
    return inserted


def _ensure_fts(conn):
    """Create FTS5 virtual table for link search if not exists."""
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
            title, relevance, category, url
        )
    """)
    # Rebuild if empty
    count = conn.execute("SELECT count(*) FROM links_fts").fetchone()[0]
    if count == 0:
        conn.execute("""
            INSERT INTO links_fts(rowid, title, relevance, category, url)
            SELECT id, coalesce(title,''), coalesce(relevance,''),
                   coalesce(category,''), coalesce(url,'')
            FROM links
        """)
        conn.commit()


def _sync_fts_row(conn, url_hash: str):
    """Sync a single link row into FTS index by url_hash."""
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
            title, relevance, category, url
        )
    """)
    row = conn.execute(
        "SELECT id, coalesce(title,''), coalesce(relevance,''), coalesce(category,''), coalesce(url,'') "
        "FROM links WHERE url_hash = ?", (url_hash,)
    ).fetchone()
    if row:
        link_id = row[0]
        conn.execute("DELETE FROM links_fts WHERE rowid = ?", (link_id,))
        conn.execute(
            "INSERT INTO links_fts(rowid, title, relevance, category, url) VALUES (?, ?, ?, ?, ?)",
            (link_id, row[1], row[2], row[3], row[4]))


def get_links(
    db_path: Path,
    *,
    category: str | None = None,
    days: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    conn = get_connection(db_path)
    where: list[str] = []
    params: list[Any] = []
    if category:
        where.append("category = ?")
        params.append(category)
    if days is not None:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        where.append("last_seen >= ?")
        params.append(cutoff)
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    params.append(min(max(1, limit), 200))
    rows = conn.execute(
        f"""SELECT id, url, url_hash, title, category, relevance, shared_by,
                   source_group, first_seen, last_seen, mention_count, value_score,
                   report_date
            FROM links {where_sql}
            ORDER BY value_score DESC, last_seen DESC
            LIMIT ?""",
        params,
    ).fetchall()
    conn.close()
    return [
        {
            "id": r[0], "url": r[1], "url_hash": r[2], "title": r[3],
            "category": r[4], "relevance": r[5], "shared_by": r[6],
            "source_group": r[7], "first_seen": r[8], "last_seen": r[9],
            "mention_count": r[10], "value_score": r[11], "report_date": r[12],
        }
        for r in rows
    ]


def search_links_fts(
    db_path: Path,
    query: str,
    *,
    category: str | None = None,
    days: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search links using FTS5 full-text search."""
    conn = get_connection(db_path)
    _ensure_fts(conn)
    q = query.strip()
    if not q:
        conn.close()
        return get_links(db_path, category=category, days=days, limit=limit)

    # FTS5 query — quote terms for safety
    fts_query = " OR ".join(f'"{term}"' for term in q.split() if term)

    where: list[str] = []
    params: list[Any] = []
    if category:
        where.append("l.category = ?")
        params.append(category)
    if days is not None:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        where.append("l.last_seen >= ?")
        params.append(cutoff)
    extra_where = f"AND {' AND '.join(where)}" if where else ""
    params.append(min(max(1, limit), 200))

    rows = conn.execute(
        f"""SELECT l.id, l.url, l.url_hash, l.title, l.category, l.relevance,
                   l.shared_by, l.source_group, l.first_seen, l.last_seen,
                   l.mention_count, l.value_score, l.report_date
            FROM links_fts f
            JOIN links l ON f.rowid = l.id
            WHERE links_fts MATCH ?
            {extra_where}
            ORDER BY rank, l.value_score DESC
            LIMIT ?""",
        (fts_query, *params),
    ).fetchall()
    conn.close()
    return [
        {
            "id": r[0], "url": r[1], "url_hash": r[2], "title": r[3],
            "category": r[4], "relevance": r[5], "shared_by": r[6],
            "source_group": r[7], "first_seen": r[8], "last_seen": r[9],
            "mention_count": r[10], "value_score": r[11], "report_date": r[12],
        }
        for r in rows
    ]
