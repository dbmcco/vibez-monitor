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
    conn.commit()
    conn.close()
    return inserted


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
