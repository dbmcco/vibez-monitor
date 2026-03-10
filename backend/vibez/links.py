# ABOUTME: Link ingestion, dedup, value scoring, and retrieval.
# ABOUTME: Handles upsert with URL-hash dedup, recency-weighted scoring, and filtered queries.

"""Link ingestion, dedup, value scoring, and retrieval."""

from __future__ import annotations

import hashlib
import math
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from vibez.db import get_connection

# Match http/https URLs in message text
_URL_RE = re.compile(r'https?://[^\s<>\"\')]+', re.IGNORECASE)

# Rooms that are NOT part of the vibez/AGI ecosystem — exclude from link extraction
EXCLUDED_ROOMS = {
    "BBC News",
    "Bloomberg News",
    "GoodSense Grocers",
    "Lightforge Development",
    "Plum",
    "MTB Rides",
    "TechRadar",
}


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


def extract_urls(text: str) -> list[str]:
    """Extract URLs from message text, stripping trailing punctuation."""
    urls = _URL_RE.findall(text)
    cleaned = []
    for url in urls:
        url = url.rstrip(".,;:!?)>]}")
        if len(url) > 10:
            cleaned.append(url)
    return cleaned


def _domain_from_url(url: str) -> str:
    try:
        host = urlparse(url).netloc
        return host.removeprefix("www.")
    except Exception:
        return ""


def upsert_message_links(
    db_path: Path,
    messages: list[dict],
) -> int:
    """Extract URLs from raw messages and upsert into links table.

    Each message dict needs: body, sender_name, timestamp, room_name.
    Only creates new rows for URLs not already tracked. For existing URLs,
    bumps mention_count and updates last_seen.
    """
    if not messages:
        return 0

    # Filter to vibez ecosystem rooms only
    messages = [m for m in messages if m.get("room_name", "") not in EXCLUDED_ROOMS]
    if not messages:
        return 0

    # Collect per-URL data: senders, message snippets, timestamps
    url_data: dict[str, dict] = {}
    for msg in messages:
        body = msg.get("body", "")
        urls = extract_urls(body)
        if not urls:
            continue
        sender = msg.get("sender_name", "")
        ts = msg.get("timestamp", 0)
        room = msg.get("room_name", "")
        for url in urls:
            h = _url_hash(url)
            if h not in url_data:
                url_data[h] = {
                    "url": url,
                    "senders": set(),
                    "snippets": [],
                    "rooms": set(),
                    "count": 0,
                    "earliest_ts": ts,
                    "latest_ts": ts,
                }
            entry = url_data[h]
            entry["count"] += 1
            entry["senders"].add(sender)
            entry["rooms"].add(room)
            if ts < entry["earliest_ts"]:
                entry["earliest_ts"] = ts
            if ts > entry["latest_ts"]:
                entry["latest_ts"] = ts
            # Keep message context for FTS (truncate long bodies)
            snippet = body[:300].strip()
            if snippet and snippet not in entry["snippets"]:
                entry["snippets"].append(snippet)

    if not url_data:
        return 0

    conn = get_connection(db_path)
    inserted = 0
    for h, data in url_data.items():
        url = data["url"]
        domain = _domain_from_url(url)
        context = " | ".join(data["snippets"][:3])
        senders = ", ".join(sorted(data["senders"]))
        existing = conn.execute(
            "SELECT id, mention_count, first_seen, title, relevance FROM links WHERE url_hash = ?",
            (h,),
        ).fetchone()

        # Use actual message timestamps, not wall clock
        latest_iso = datetime.utcfromtimestamp(data["latest_ts"] / 1000).isoformat() if data["latest_ts"] else datetime.now().isoformat()
        earliest_iso = datetime.utcfromtimestamp(data["earliest_ts"] / 1000).isoformat() if data["earliest_ts"] else latest_iso

        if existing:
            new_count = (existing[1] or 1) + data["count"]
            days_ago = (datetime.now() - datetime.fromisoformat(existing[2])).days if existing[2] else 0
            score = compute_value_score(new_count, days_ago)
            # If existing row has no relevance (empty), enrich with message context
            if not existing[4]:
                conn.execute(
                    "UPDATE links SET mention_count=?, last_seen=?, value_score=?, relevance=? WHERE id=?",
                    (new_count, latest_iso, score, context, existing[0]),
                )
            else:
                conn.execute(
                    "UPDATE links SET mention_count=?, last_seen=?, value_score=? WHERE id=?",
                    (new_count, latest_iso, score, existing[0]),
                )
        else:
            score = compute_value_score(data["count"], 0)
            conn.execute(
                """INSERT INTO links (url, url_hash, title, category, relevance,
                   shared_by, source_group, first_seen, last_seen, mention_count,
                   value_score, report_date)
                   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '')""",
                (url, h, domain, context, senders,
                 ", ".join(sorted(data["rooms"])),
                 earliest_iso, latest_iso, data["count"], score),
            )
            inserted += 1
        _sync_fts_row(conn, h)
    conn.commit()
    conn.close()
    return inserted


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
