"""Semantic indexing and hybrid retrieval for optional pgvector support."""

from __future__ import annotations

import json
import logging
import math
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Sequence

from vibez.db import get_connection

logger = logging.getLogger("vibez.semantic_index")

DEFAULT_TABLE = "vibez_message_embeddings"
DEFAULT_DIMENSIONS = 256

_TOKEN_RE = re.compile(r"[a-z0-9]{2,}")
_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
_TITLE_STOPWORDS = {
    "about",
    "after",
    "also",
    "around",
    "because",
    "being",
    "could",
    "from",
    "have",
    "just",
    "like",
    "more",
    "only",
    "over",
    "really",
    "some",
    "that",
    "them",
    "then",
    "there",
    "they",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
    "your",
}


def _validate_table_name(table: str) -> str:
    normalized = (table or "").strip().lower()
    if not normalized:
        raise ValueError("pgvector table name cannot be empty")
    if not _IDENT_RE.fullmatch(normalized):
        raise ValueError(
            f"invalid pgvector table name '{table}'; use lowercase letters, digits, and underscores only"
        )
    return normalized


def _normalize_dimensions(dimensions: int | None) -> int:
    value = int(dimensions or DEFAULT_DIMENSIONS)
    if value < 64 or value > 3072:
        raise ValueError("pgvector dimensions must be between 64 and 3072")
    return value


def _fnv1a(value: str, seed: int) -> int:
    h = seed & 0xFFFFFFFF
    for b in value.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _tokens(text: str) -> list[str]:
    if not text:
        return []
    return _TOKEN_RE.findall(text.lower())


def embed_text(text: str, dimensions: int = DEFAULT_DIMENSIONS) -> list[float]:
    """Build a deterministic dense vector without external model dependencies."""
    dims = _normalize_dimensions(dimensions)
    vec = [0.0] * dims
    tokens = _tokens(text)
    if not tokens:
        return vec

    for token in tokens:
        base = 1.0 / max(1.0, math.sqrt(len(token)))
        idx_main = _fnv1a(token, 0x811C9DC5) % dims
        idx_side = _fnv1a(token, 0x9E3779B1) % dims
        vec[idx_main] += base
        vec[idx_side] -= base * 0.35

        if len(token) >= 5:
            for i in range(len(token) - 2):
                tri = token[i : i + 3]
                idx_tri = _fnv1a(tri, 0x85EBCA6B) % dims
                vec[idx_tri] += 0.15

    norm = math.sqrt(sum(value * value for value in vec))
    if norm <= 0:
        return vec
    return [value / norm for value in vec]


def _vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def _parse_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _compose_embedding_text(row: dict[str, Any]) -> str:
    topics = " ".join(_parse_json_list(row.get("topics")))
    entities = " ".join(_parse_json_list(row.get("entities")))
    themes = " ".join(_parse_json_list(row.get("contribution_themes")))
    hint = str(row.get("contribution_hint") or "")
    return " \n ".join(
        part
        for part in [
            str(row.get("body") or ""),
            topics,
            entities,
            themes,
            hint,
            str(row.get("room_name") or ""),
            str(row.get("sender_name") or ""),
        ]
        if part
    )


def _import_psycopg():
    try:
        import psycopg
    except ImportError as exc:  # pragma: no cover - explicit operator guidance
        raise RuntimeError(
            "psycopg is required for pgvector indexing. Install with: pip install 'psycopg[binary]>=3.2'"
        ) from exc
    return psycopg


def ensure_pgvector_schema(
    pg_url: str,
    *,
    table: str = DEFAULT_TABLE,
    dimensions: int = DEFAULT_DIMENSIONS,
) -> None:
    """Create extension/table/indexes if needed."""
    table_name = _validate_table_name(table)
    dims = _normalize_dimensions(dimensions)
    psycopg = _import_psycopg()
    idx_prefix = f"{table_name}_idx"

    create_table_sql = f"""
CREATE TABLE IF NOT EXISTS {table_name} (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_name TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    body TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    relevance_score DOUBLE PRECISION,
    topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    entities JSONB NOT NULL DEFAULT '[]'::jsonb,
    contribution_flag BOOLEAN NOT NULL DEFAULT FALSE,
    contribution_themes JSONB NOT NULL DEFAULT '[]'::jsonb,
    contribution_hint TEXT,
    alert_level TEXT,
    embedding VECTOR({dims}) NOT NULL,
    body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

    with psycopg.connect(pg_url) as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cur.execute(create_table_sql)
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS {idx_prefix}_embedding "
                f"ON {table_name} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
            )
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS {idx_prefix}_tsv ON {table_name} USING gin (body_tsv)"
            )
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS {idx_prefix}_timestamp ON {table_name} (timestamp DESC)"
            )
        conn.commit()


def _fetch_sqlite_rows(
    db_path: Path,
    *,
    message_ids: Sequence[str] | None = None,
    since_ts: int | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    conn = get_connection(db_path)
    where_parts: list[str] = []
    params: list[Any] = []
    if since_ts is not None:
        where_parts.append("m.timestamp >= ?")
        params.append(int(since_ts))
    if message_ids:
        placeholders = ",".join("?" for _ in message_ids)
        where_parts.append(f"m.id IN ({placeholders})")
        params.extend(message_ids)
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    limit_sql = f"LIMIT {int(limit)}" if limit and limit > 0 else ""

    cursor = conn.execute(
        f"""SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name,
                   m.body, m.timestamp, c.relevance_score, c.topics, c.entities,
                   c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
            FROM messages m
            LEFT JOIN classifications c ON m.id = c.message_id
            {where_sql}
            ORDER BY m.timestamp DESC
            {limit_sql}""",
        params,
    )
    rows = [
        {
            "id": row[0],
            "room_id": row[1],
            "room_name": row[2],
            "sender_id": row[3],
            "sender_name": row[4],
            "body": row[5],
            "timestamp": row[6],
            "relevance_score": row[7],
            "topics": row[8] if row[8] else "[]",
            "entities": row[9] if row[9] else "[]",
            "contribution_flag": row[10],
            "contribution_themes": row[11] if row[11] else "[]",
            "contribution_hint": row[12],
            "alert_level": row[13],
        }
        for row in cursor.fetchall()
    ]
    conn.close()
    return rows


def index_rows_to_pgvector(
    pg_url: str,
    rows: Sequence[dict[str, Any]],
    *,
    table: str = DEFAULT_TABLE,
    dimensions: int = DEFAULT_DIMENSIONS,
) -> int:
    """Upsert pre-fetched rows into the pgvector table."""
    if not rows:
        return 0

    table_name = _validate_table_name(table)
    dims = _normalize_dimensions(dimensions)
    psycopg = _import_psycopg()
    ensure_pgvector_schema(pg_url, table=table_name, dimensions=dims)

    sql = f"""
INSERT INTO {table_name} (
    message_id, room_id, room_name, sender_id, sender_name, body, timestamp,
    relevance_score, topics, entities, contribution_flag, contribution_themes,
    contribution_hint, alert_level, embedding, updated_at
) VALUES (
    %s, %s, %s, %s, %s, %s, %s,
    %s, %s::jsonb, %s::jsonb, %s, %s::jsonb,
    %s, %s, %s::vector, now()
)
ON CONFLICT (message_id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    room_name = EXCLUDED.room_name,
    sender_id = EXCLUDED.sender_id,
    sender_name = EXCLUDED.sender_name,
    body = EXCLUDED.body,
    timestamp = EXCLUDED.timestamp,
    relevance_score = EXCLUDED.relevance_score,
    topics = EXCLUDED.topics,
    entities = EXCLUDED.entities,
    contribution_flag = EXCLUDED.contribution_flag,
    contribution_themes = EXCLUDED.contribution_themes,
    contribution_hint = EXCLUDED.contribution_hint,
    alert_level = EXCLUDED.alert_level,
    embedding = EXCLUDED.embedding,
    updated_at = now();
"""
    payload: list[tuple[Any, ...]] = []
    for row in rows:
        embedding_text = _compose_embedding_text(row)
        embedding = _vector_literal(embed_text(embedding_text, dims))
        payload.append(
            (
                row["id"],
                row["room_id"],
                row["room_name"],
                row["sender_id"],
                row["sender_name"],
                row["body"] or "",
                int(row["timestamp"]),
                row["relevance_score"],
                row["topics"] or "[]",
                row["entities"] or "[]",
                bool(row["contribution_flag"] or 0),
                row["contribution_themes"] or "[]",
                row["contribution_hint"],
                row["alert_level"],
                embedding,
            )
        )

    with psycopg.connect(pg_url) as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, payload)
        conn.commit()
    return len(payload)


def index_sqlite_messages(
    db_path: Path,
    pg_url: str,
    *,
    table: str = DEFAULT_TABLE,
    dimensions: int = DEFAULT_DIMENSIONS,
    message_ids: Sequence[str] | None = None,
    lookback_days: int | None = None,
    limit: int | None = None,
) -> int:
    """Read rows from SQLite and upsert them into pgvector."""
    since_ts = None
    if lookback_days is not None and lookback_days > 0:
        since_ts = int((datetime.now() - timedelta(days=lookback_days)).timestamp() * 1000)
    rows = _fetch_sqlite_rows(
        db_path,
        message_ids=message_ids,
        since_ts=since_ts,
        limit=limit,
    )
    return index_rows_to_pgvector(
        pg_url,
        rows,
        table=table,
        dimensions=dimensions,
    )


def search_hybrid_pgvector(
    pg_url: str,
    query: str,
    *,
    lookback_days: int = 7,
    limit: int = 50,
    table: str = DEFAULT_TABLE,
    dimensions: int = DEFAULT_DIMENSIONS,
) -> list[dict[str, Any]]:
    """Hybrid semantic + lexical retrieval from pgvector index."""
    table_name = _validate_table_name(table)
    dims = _normalize_dimensions(dimensions)
    resolved_limit = max(1, min(int(limit), 200))
    cutoff_ts = int((datetime.now() - timedelta(days=lookback_days)).timestamp() * 1000)
    query_text = (query or "").strip()
    query_vec = _vector_literal(embed_text(query_text, dims))
    psycopg = _import_psycopg()

    sql = f"""
WITH params AS (
  SELECT %s::vector AS qvec, NULLIF(%s, '') AS qtext, %s::bigint AS cutoff
)
SELECT
  m.message_id,
  m.room_name,
  m.sender_name,
  m.body,
  m.timestamp,
  m.relevance_score,
  m.topics::text,
  m.contribution_hint,
  (1 - (m.embedding <=> p.qvec)) AS semantic_score,
  CASE
    WHEN p.qtext IS NULL THEN 0
    ELSE ts_rank_cd(m.body_tsv, websearch_to_tsquery('english', p.qtext))
  END AS lexical_score
FROM {table_name} m
CROSS JOIN params p
WHERE m.timestamp >= p.cutoff
ORDER BY
  (0.65 * (1 - (m.embedding <=> p.qvec)))
  + (
      CASE
        WHEN p.qtext IS NULL THEN 0
        ELSE 0.25 * LEAST(2, ts_rank_cd(m.body_tsv, websearch_to_tsquery('english', p.qtext)))
      END
    )
  + (0.10 * (COALESCE(m.relevance_score, 0) / 10.0)) DESC,
  m.timestamp DESC
LIMIT %s;
"""

    with psycopg.connect(pg_url) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (query_vec, query_text, cutoff_ts, resolved_limit))
            rows = cur.fetchall()

    return [
        {
            "room_name": row[1],
            "sender_name": row[2],
            "body": row[3],
            "timestamp": row[4],
            "relevance_score": row[5] or 0,
            "topics": _parse_json_list(row[6]),
            "contribution_hint": row[7] or "",
            "semantic_score": float(row[8] or 0),
            "lexical_score": float(row[9] or 0),
        }
        for row in rows
    ]


def _arc_title_from_bodies(bodies: Sequence[str]) -> str:
    counts: dict[str, int] = {}
    for body in bodies:
        for token in _tokens(body.lower())[:80]:
            if len(token) < 4 or token in _TITLE_STOPWORDS:
                continue
            counts[token] = counts.get(token, 0) + 1
    top = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:3]
    if len(top) >= 2:
        return f"{top[0][0]} / {top[1][0]}"
    if top:
        return top[0][0]
    fallback = (bodies[0] if bodies else "semantic thread").strip()
    return fallback[:44] if fallback else "semantic thread"


def get_semantic_arc_hints(
    pg_url: str,
    *,
    lookback_hours: int = 24,
    table: str = DEFAULT_TABLE,
    max_arcs: int = 4,
) -> list[dict[str, Any]]:
    """Derive compact arc hints from pgvector neighborhoods for synthesis context."""
    table_name = _validate_table_name(table)
    psycopg = _import_psycopg()

    hours = max(6, min(int(lookback_hours), 168))
    cutoff_ts = int((datetime.now() - timedelta(hours=hours)).timestamp() * 1000)
    candidate_limit = 1200
    seed_limit = 220
    neighbor_limit = 32
    distance_threshold = 0.30
    min_cluster_size = 3
    cluster_build_limit = max(max_arcs * 4, 12)

    candidate_sql = f"""
SELECT message_id, sender_name, room_name, body, timestamp, COALESCE(relevance_score, 0) AS relevance_score
FROM {table_name}
WHERE timestamp >= %s AND length(trim(body)) >= 24
ORDER BY COALESCE(relevance_score, 0) DESC, timestamp DESC
LIMIT %s
"""

    with psycopg.connect(pg_url) as conn:
        with conn.cursor() as cur:
            cur.execute(candidate_sql, (cutoff_ts, candidate_limit))
            candidates = cur.fetchall()

            if not candidates:
                return []

            seed_ids = [str(row[0]) for row in candidates[:seed_limit]]
            if not seed_ids:
                return []

            neighbor_sql = f"""
WITH anchors AS (
  SELECT message_id, embedding
  FROM {table_name}
  WHERE message_id = ANY(%s::text[])
)
SELECT
  a.message_id AS anchor_id,
  n.message_id,
  n.sender_name,
  n.room_name,
  n.body,
  n.timestamp,
  n.distance
FROM anchors a
JOIN LATERAL (
  SELECT
    m.message_id,
    m.sender_name,
    m.room_name,
    m.body,
    m.timestamp,
    (m.embedding <=> a.embedding) AS distance
  FROM {table_name} m
  WHERE m.message_id <> a.message_id AND m.timestamp >= %s
  ORDER BY m.embedding <=> a.embedding
  LIMIT %s
) n ON true
"""
            cur.execute(neighbor_sql, (seed_ids, cutoff_ts, neighbor_limit))
            neighbors = cur.fetchall()

    candidate_by_id = {
        str(row[0]): {
            "message_id": str(row[0]),
            "sender_name": str(row[1] or "Unknown"),
            "room_name": str(row[2] or "Unknown"),
            "body": str(row[3] or ""),
            "timestamp": int(row[4] or 0),
            "relevance_score": float(row[5] or 0),
        }
        for row in candidates
    }
    seed_rows = [candidate_by_id[sid] for sid in seed_ids if sid in candidate_by_id]

    neighbors_by_anchor: dict[str, list[dict[str, Any]]] = {}
    for row in neighbors:
        anchor_id = str(row[0])
        entry = {
            "message_id": str(row[1]),
            "sender_name": str(row[2] or "Unknown"),
            "room_name": str(row[3] or "Unknown"),
            "body": str(row[4] or ""),
            "timestamp": int(row[5] or 0),
            "distance": float(row[6] or 1.0),
        }
        neighbors_by_anchor.setdefault(anchor_id, []).append(entry)
    for items in neighbors_by_anchor.values():
        items.sort(key=lambda item: item["distance"])

    used: set[str] = set()
    hints: list[dict[str, Any]] = []
    now_ts = int(datetime.now().timestamp() * 1000)
    recent_cutoff = now_ts - 24 * 60 * 60 * 1000
    prev_cutoff = now_ts - 48 * 60 * 60 * 1000

    for anchor in seed_rows:
        if len(hints) >= cluster_build_limit:
            break
        anchor_id = anchor["message_id"]
        if anchor_id in used:
            continue
        members: list[dict[str, Any]] = [anchor]
        distances = [0.0]
        seen = {anchor_id}
        for neighbor in neighbors_by_anchor.get(anchor_id, []):
            if neighbor["distance"] > distance_threshold:
                break
            message_id = neighbor["message_id"]
            if message_id in seen or message_id in used:
                continue
            row = candidate_by_id.get(message_id) or {
                "message_id": message_id,
                "sender_name": neighbor["sender_name"],
                "room_name": neighbor["room_name"],
                "body": neighbor["body"],
                "timestamp": neighbor["timestamp"],
                "relevance_score": 0.0,
            }
            members.append(row)
            distances.append(float(neighbor["distance"]))
            seen.add(message_id)
        if len(members) < min_cluster_size:
            continue
        for member in members:
            used.add(member["message_id"])
        members.sort(key=lambda item: int(item["timestamp"]), reverse=True)
        people = sorted({str(item["sender_name"]) for item in members})
        channels = sorted({str(item["room_name"]) for item in members})
        first_ts = min(int(item["timestamp"]) for item in members)
        last_ts = max(int(item["timestamp"]) for item in members)
        coherence = sum(max(0.0, 1.0 - d) for d in distances) / max(1, len(distances))

        last_24 = sum(1 for item in members if int(item["timestamp"]) >= recent_cutoff)
        prev_24 = sum(
            1
            for item in members
            if prev_cutoff <= int(item["timestamp"]) < recent_cutoff
        )
        momentum = "steady"
        if last_24 >= prev_24 + 2:
            momentum = "rising"
        elif prev_24 >= last_24 + 2:
            momentum = "cooling"

        hints.append(
            {
                "title": _arc_title_from_bodies([str(item["body"]) for item in members]),
                "message_count": len(members),
                "people": len(people),
                "channels": len(channels),
                "coherence": round(coherence, 3),
                "momentum": momentum,
                "first_seen": datetime.fromtimestamp(first_ts / 1000).strftime("%Y-%m-%d"),
                "last_seen": datetime.fromtimestamp(last_ts / 1000).strftime("%Y-%m-%d"),
                "participants": people[:5],
                "sample_quote": str(members[0].get("body", ""))[:220],
            }
        )

    hints.sort(key=lambda item: (-int(item["message_count"]), -float(item["coherence"])))
    return hints[:max_arcs]
