# ABOUTME: Link ingestion, dedup, value scoring, and retrieval.
# ABOUTME: Handles upsert with URL-hash dedup, recency-weighted scoring, and filtered queries.

"""Link ingestion, dedup, value scoring, and retrieval."""

from __future__ import annotations

import hashlib
import math
import re
from datetime import datetime, timedelta, timezone
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
            "SELECT id, mention_count, first_seen, shared_by FROM links WHERE url_hash = ?", (h,)
        ).fetchone()
        if existing:
            new_count = (existing[1] or 1) + 1
            days_ago = (datetime.now() - datetime.fromisoformat(existing[2])).days if existing[2] else 0
            score = compute_value_score(new_count, days_ago)
            if not existing[3] and shared_by:
                conn.execute(
                    """UPDATE links SET mention_count = ?, last_seen = ?, value_score = ?,
                       report_date = ?, shared_by = ? WHERE id = ?""",
                    (new_count, now, score, report_date, shared_by, existing[0]),
                )
            else:
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


def _normalize_link_search_term(raw: str) -> str:
    term = raw.replace("’", "'")
    term = re.sub(r"^[^\w:/._-]+|[^\w:/._-]+$", "", term)
    term = re.sub(r"'s$", "", term, flags=re.IGNORECASE)
    return term.replace("'", "")


def _build_links_fts_query(query: str) -> tuple[str, list[str]]:
    terms: list[str] = []
    for raw in query.strip().split():
        normalized = _normalize_link_search_term(raw)
        if normalized and normalized not in terms:
            terms.append(normalized)
    return " OR ".join(f'"{term}"' for term in terms), terms


def _build_term_match_score_sql(alias: str, terms: list[str]) -> tuple[str, list[Any]]:
    searchable = (
        f"lower(coalesce({alias}.title,'') || ' ' || coalesce({alias}.relevance,'') || ' ' "
        f"|| coalesce({alias}.category,'') || ' ' || coalesce({alias}.url,''))"
    )
    clauses: list[str] = []
    params: list[Any] = []
    for term in terms:
        clauses.append(f"CASE WHEN {searchable} LIKE ? THEN ? ELSE 0 END")
        params.extend([f"%{term.lower()}%", len(term)])
    if not clauses:
        return "0", []
    return " + ".join(clauses), params


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


def _days_since_iso(iso_timestamp: str | None) -> int:
    if not iso_timestamp:
        return 0
    try:
        parsed = datetime.fromisoformat(iso_timestamp)
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(tz=timezone.utc) - parsed).days)


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
            "SELECT id, mention_count, first_seen, title, relevance, shared_by FROM links WHERE url_hash = ?",
            (h,),
        ).fetchone()

        # Use actual message timestamps, not wall clock
        latest_iso = (
            datetime.fromtimestamp(data["latest_ts"] / 1000, tz=timezone.utc).isoformat()
            if data["latest_ts"]
            else datetime.now(tz=timezone.utc).isoformat()
        )
        earliest_iso = (
            datetime.fromtimestamp(data["earliest_ts"] / 1000, tz=timezone.utc).isoformat()
            if data["earliest_ts"]
            else latest_iso
        )

        if existing:
            new_count = (existing[1] or 1) + data["count"]
            days_ago = _days_since_iso(existing[2])
            score = compute_value_score(new_count, days_ago)
            # If existing row has no relevance (empty), enrich with message context
            no_relevance = not existing[4]
            no_shared_by = not existing[5] and senders
            if no_relevance and no_shared_by:
                conn.execute(
                    "UPDATE links SET mention_count=?, last_seen=?, value_score=?, relevance=?, shared_by=? WHERE id=?",
                    (new_count, latest_iso, score, context, senders, existing[0]),
                )
            elif no_relevance:
                conn.execute(
                    "UPDATE links SET mention_count=?, last_seen=?, value_score=?, relevance=? WHERE id=?",
                    (new_count, latest_iso, score, context, existing[0]),
                )
            elif no_shared_by:
                conn.execute(
                    "UPDATE links SET mention_count=?, last_seen=?, value_score=?, shared_by=? WHERE id=?",
                    (new_count, latest_iso, score, senders, existing[0]),
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


def _load_links_refresh_watermark(
    conn,
    *,
    state_key: str = "links_last_refresh_ts",
) -> int | None:
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key = ?",
        (state_key,),
    ).fetchone()
    if not row:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


def _save_links_refresh_watermark(
    conn,
    timestamp_ms: int,
    *,
    state_key: str = "links_last_refresh_ts",
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        (state_key, str(timestamp_ms)),
    )


def refresh_message_links(
    db_path: Path,
    *,
    allowed_groups: set[str] | None = None,
    full_rebuild: bool = False,
    batch_size: int = 500,
    state_key: str = "links_last_refresh_ts",
) -> dict[str, int]:
    """Refresh the links table from message bodies, incrementally by timestamp."""
    conn = get_connection(db_path)
    allowed_groups_normalized = {
        str(name).strip().casefold()
        for name in (allowed_groups or set())
        if str(name).strip()
    }
    preserved_metadata: dict[str, dict[str, Any]] = {}

    watermark = None if full_rebuild else _load_links_refresh_watermark(conn, state_key=state_key)

    if full_rebuild:
        rows = conn.execute(
            "SELECT url_hash, title, category, relevance, authored_by, pinned FROM links"
        ).fetchall()
        preserved_metadata = {
            str(row[0]): {
                "title": str(row[1] or "").strip(),
                "category": str(row[2] or "").strip(),
                "relevance": str(row[3] or "").strip(),
                "authored_by": str(row[4] or "").strip(),
                "pinned": int(row[5] or 0),
            }
            for row in rows
            if str(row[0] or "").strip()
        }
        fts_exists = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='links_fts'"
        ).fetchone()
        if fts_exists:
            conn.execute("DELETE FROM links_fts")
        conn.execute("DELETE FROM links")
        conn.commit()

    where: list[str] = ["body LIKE '%http%'"]
    params: list[Any] = []
    if EXCLUDED_ROOMS:
        placeholders = ",".join("?" for _ in EXCLUDED_ROOMS)
        where.append(f"room_name NOT IN ({placeholders})")
        params.extend(sorted(EXCLUDED_ROOMS))
    if watermark is not None:
        where.append("timestamp > ?")
        params.append(watermark)

    rows = conn.execute(
        "SELECT id, body, sender_name, timestamp, room_name "
        f"FROM messages WHERE {' AND '.join(where)} ORDER BY timestamp ASC",
        params,
    ).fetchall()
    conn.close()

    messages = [
        {
            "id": row[0],
            "body": row[1],
            "sender_name": row[2],
            "timestamp": row[3],
            "room_name": row[4],
        }
        for row in rows
        if (
            not allowed_groups_normalized
            or str(row[4] or "").strip().casefold() in allowed_groups_normalized
        )
    ]

    latest_timestamp = max(
        (int(message["timestamp"]) for message in messages),
        default=watermark or 0,
    )
    links_inserted = 0
    for start in range(0, len(messages), max(1, batch_size)):
        links_inserted += upsert_message_links(
            db_path,
            messages[start : start + max(1, batch_size)],
        )

    conn = get_connection(db_path)
    if full_rebuild and preserved_metadata:
        for url_hash, metadata in preserved_metadata.items():
            current = conn.execute(
                "SELECT id, title, category, relevance, authored_by, pinned FROM links WHERE url_hash = ?",
                (url_hash,),
            ).fetchone()
            if not current:
                continue
            link_id = current[0]
            title = str(current[1] or "").strip()
            category = str(current[2] or "").strip()
            relevance = str(current[3] or "").strip()
            authored_by = str(current[4] or "").strip()
            pinned = int(current[5] or 0)

            new_title = title
            if metadata["title"] and len(metadata["title"]) > len(title):
                new_title = metadata["title"]

            new_category = category or metadata["category"]

            new_relevance = relevance
            if metadata["relevance"] and len(metadata["relevance"]) > len(relevance):
                new_relevance = metadata["relevance"]

            new_authored_by = authored_by or metadata["authored_by"]
            new_pinned = 1 if pinned or metadata["pinned"] else 0

            conn.execute(
                "UPDATE links SET title = ?, category = ?, relevance = ?, authored_by = ?, pinned = ? WHERE id = ?",
                (new_title, new_category, new_relevance, new_authored_by, new_pinned, link_id),
            )
            _sync_fts_row(conn, url_hash)
    if latest_timestamp:
        _save_links_refresh_watermark(conn, latest_timestamp, state_key=state_key)
    conn.commit()
    conn.close()

    return {
        "messages_scanned": len(messages),
        "links_inserted": links_inserted,
        "latest_timestamp": latest_timestamp,
    }


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

    fts_query, terms = _build_links_fts_query(q)
    if not terms:
        conn.close()
        return get_links(db_path, category=category, days=days, limit=limit)
    match_score_sql, match_score_params = _build_term_match_score_sql("l", terms)

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
                   l.mention_count, l.value_score, l.report_date,
                   ({match_score_sql}) AS term_match_score
            FROM links_fts f
            JOIN links l ON f.rowid = l.id
            WHERE links_fts MATCH ?
            {extra_where}
            ORDER BY term_match_score DESC, rank, l.value_score DESC
            LIMIT ?""",
        (*match_score_params, fts_query, *params),
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
