# ABOUTME: Knowledge extraction pipeline for collective wisdom.
# ABOUTME: Batch job that classifies messages into knowledge types and topic clusters using Haiku.

"""Extract collective wisdom from chat history into structured knowledge."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from anthropic import Anthropic

from vibez.db import get_connection
from vibez.links import EXCLUDED_ROOMS

logger = logging.getLogger("vibez.wisdom")

KNOWLEDGE_TYPES = [
    "stack",
    "architecture",
    "best_practices",
    "config",
    "research",
    "tutorial",
    "news",
    "opinion",
    "showcase",
    "people",
]

CLASSIFICATION_SYSTEM = "Return strict JSON array only. Do not include markdown fences, prose, or explanations."

CLASSIFICATION_PROMPT = """Analyze these chat messages from a tech community and extract knowledge items.

For each distinct piece of knowledge discussed, classify it:
- knowledge_type: one of {types}
- topic: short topic name (2-4 words, e.g. "agent frameworks", "vector databases", "MCP protocol")
- title: one-line summary of the knowledge (what was said/shared)
- summary: 1-2 sentence synthesis of the group's take
- contributors: list of sender names who contributed to this knowledge
- links: any URLs mentioned in context
- confidence: 0.0-1.0 how clearly this was discussed

Return JSON array. If no extractable knowledge, return [].

Messages:
{messages}"""

CONSENSUS_PROMPT = """Given these knowledge items about "{topic}" from a tech community, write a 2-3 sentence synthesis of what the group collectively thinks about this topic.

Items:
{items}

Write the synthesis as if summarizing the group's collective view. Be specific about tools, preferences, and opinions expressed."""


def _topic_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower().strip())
    return slug.strip("-")[:80]


def _format_iso_from_ms(timestamp_ms: int | float | None) -> str | None:
    if not timestamp_ms:
        return None
    return datetime.fromtimestamp(float(timestamp_ms) / 1000, tz=timezone.utc).isoformat()


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _normalize_string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _chunk_messages(messages: list[dict[str, Any]], window_hours: float = 2.0) -> list[list[dict[str, Any]]]:
    """Group messages by room and time window."""
    if not messages:
        return []

    sorted_msgs = sorted(messages, key=lambda msg: (msg.get("room_name", ""), msg.get("timestamp", 0)))
    chunks: list[list[dict[str, Any]]] = []
    current_chunk: list[dict[str, Any]] = []
    current_room = ""
    chunk_start_ts = 0
    window_ms = int(window_hours * 3600 * 1000)

    for msg in sorted_msgs:
        room = str(msg.get("room_name", "") or "")
        ts = int(msg.get("timestamp", 0) or 0)

        if room != current_room or (current_chunk and ts - chunk_start_ts > window_ms):
            if current_chunk:
                chunks.append(current_chunk)
            current_chunk = [msg]
            current_room = room
            chunk_start_ts = ts
            continue

        if not current_chunk:
            current_room = room
            chunk_start_ts = ts
        current_chunk.append(msg)

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def _format_chunk_for_llm(chunk: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for msg in chunk[:30]:
        sender = msg.get("sender_name", "?")
        body = str(msg.get("body", "") or "")[:500]
        room = msg.get("room_name", "")
        lines.append(f"[{room}] {sender}: {body}")
    return "\n".join(lines)


def _response_text(response: Any) -> str:
    texts: list[str] = []
    for block in getattr(response, "content", []) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return "\n".join(texts).strip()


def _parse_json_payload(raw: str) -> Any | None:
    if not raw or not raw.strip():
        return None

    candidates: list[str] = [raw.strip()]
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fenced:
        candidates.append(fenced.group(1).strip())

    for opener, closer in (("{", "}"), ("[", "]")):
        start = raw.find(opener)
        end = raw.rfind(closer)
        if start >= 0 and end > start:
            candidates.append(raw[start : end + 1].strip())

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def classify_chunk(client: Anthropic, model: str, chunk: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Classify a chunk of messages into knowledge items."""
    formatted = _format_chunk_for_llm(chunk)
    if not formatted.strip():
        return []

    prompt = CLASSIFICATION_PROMPT.format(
        types=", ".join(KNOWLEDGE_TYPES),
        messages=formatted,
    )

    try:
        response = client.messages.create(
            model=model,
            max_tokens=2048,
            system=CLASSIFICATION_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = _response_text(response)
        items = _parse_json_payload(raw)
        if isinstance(items, dict) and isinstance(items.get("items"), list):
            items = items["items"]
        if isinstance(items, list):
            return items
        logger.warning("Wisdom classifier returned non-array payload: %r", raw[:200])
        return []
    except Exception:
        logger.exception("Failed to classify wisdom chunk")
        return []


def synthesize_topic(client: Anthropic, model: str, topic_name: str, items: list[dict[str, Any]]) -> str:
    """Generate a consensus summary for a topic."""
    items_text = "\n".join(
        f"- [{item.get('knowledge_type', '?')}] {item.get('title', '?')}: {item.get('summary', '')}"
        for item in items[:20]
    )
    prompt = CONSENSUS_PROMPT.format(topic=topic_name, items=items_text)

    try:
        response = client.messages.create(
            model=model,
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        return _response_text(response)
    except Exception:
        logger.exception("Failed to synthesize wisdom topic %s", topic_name)
        return ""


def _best_topic_summary(items: list[dict[str, Any]]) -> str:
    ranked = sorted(
        items,
        key=lambda item: (
            float(item.get("confidence", 0.0) or 0.0),
            len(str(item.get("summary", "") or "").strip()),
        ),
        reverse=True,
    )
    for item in ranked:
        summary = str(item.get("summary", "") or "").strip()
        if summary:
            return summary
    for item in ranked:
        title = str(item.get("title", "") or "").strip()
        if title:
            return title
    return ""


def _fetch_messages(conn: Any, watermark: int | None) -> list[dict[str, Any]]:
    where_parts = ["LENGTH(body) > 20"]
    params: list[Any] = []

    if EXCLUDED_ROOMS:
        placeholders = ",".join("?" for _ in EXCLUDED_ROOMS)
        where_parts.append(f"room_name NOT IN ({placeholders})")
        params.extend(sorted(EXCLUDED_ROOMS))

    if watermark is not None:
        where_parts.append("timestamp > ?")
        params.append(watermark)

    rows = conn.execute(
        "SELECT id, body, sender_name, timestamp, room_name "
        f"FROM messages WHERE {' AND '.join(where_parts)} ORDER BY timestamp ASC",
        params,
    ).fetchall()

    return [
        {
            "id": row[0],
            "body": row[1],
            "sender_name": row[2],
            "timestamp": row[3],
            "room_name": row[4],
        }
        for row in rows
    ]


def _load_watermark(conn: Any, full_rebuild: bool) -> int | None:
    if full_rebuild:
        return None
    row = conn.execute("SELECT value FROM sync_state WHERE key = 'wisdom_last_run'").fetchone()
    if not row:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


def run_wisdom_extraction(
    db_path: Path,
    api_key: str,
    model: str = "claude-haiku-4-5-20251001",
    full_rebuild: bool = False,
) -> dict[str, int]:
    """Run the full wisdom extraction batch job."""
    conn = get_connection(db_path)
    watermark = _load_watermark(conn, full_rebuild)
    messages = _fetch_messages(conn, watermark)
    conn.close()

    logger.info("Processing %d messages for wisdom extraction", len(messages))
    if not messages:
        return {
            "chunks_processed": 0,
            "items_extracted": 0,
            "topics_created": 0,
            "recommendations_created": 0,
        }

    chunks = _chunk_messages(messages)
    logger.info("Split %d messages into %d chunks", len(messages), len(chunks))

    client = Anthropic(api_key=api_key)
    all_items: list[dict[str, Any]] = []

    for index, chunk in enumerate(chunks, start=1):
        items = classify_chunk(client, model, chunk)
        source_message_ids = [msg["id"] for msg in chunk]
        source_timestamps = [int(msg.get("timestamp", 0) or 0) for msg in chunk]
        for item in items:
            item["_source_messages"] = source_message_ids
            item["_source_timestamps"] = source_timestamps
        all_items.extend(items)
        if index % 50 == 0:
            logger.info("Classified %d/%d chunks (%d raw items)", index, len(chunks), len(all_items))

    topic_items: dict[str, list[dict[str, Any]]] = {}
    for item in all_items:
        topic_name = str(item.get("topic", "") or "").strip()
        title = str(item.get("title", "") or "").strip()
        if not topic_name or not title:
            continue
        slug = _topic_slug(topic_name)
        normalized = {
            "knowledge_type": item.get("knowledge_type", "opinion"),
            "title": title,
            "summary": str(item.get("summary", "") or "").strip(),
            "contributors": _normalize_string_list(item.get("contributors")),
            "links": _normalize_string_list(item.get("links")),
            "confidence": float(item.get("confidence", 0.5) or 0.5),
            "_source_messages": list(item.get("_source_messages", [])),
            "_source_timestamps": list(item.get("_source_timestamps", [])),
            "_topic_name": topic_name,
            "_slug": slug,
        }
        topic_items.setdefault(slug, []).append(normalized)

    conn = get_connection(db_path)
    if full_rebuild:
        conn.execute("DELETE FROM wisdom_recommendations")
        conn.execute("DELETE FROM wisdom_items")
        conn.execute("DELETE FROM wisdom_topics")

    topics_created = 0
    items_saved = 0
    topic_metadata: dict[str, dict[str, Any]] = {}

    for slug, items in topic_items.items():
        topic_name = items[0]["_topic_name"]
        summary = synthesize_topic(client, model, topic_name, items) if items else ""
        if not summary:
            summary = _best_topic_summary(items)

        contributors = sorted(
            {
                contributor
                for item in items
                for contributor in _normalize_string_list(item.get("contributors"))
            }
        )
        source_message_ids = sorted(
            {
                source_id
                for item in items
                for source_id in item.get("_source_messages", [])
            }
        )
        last_timestamp = max(
            (timestamp for item in items for timestamp in item.get("_source_timestamps", []) if timestamp),
            default=0,
        )
        last_active = _format_iso_from_ms(last_timestamp)
        now = _now_iso()

        existing = conn.execute("SELECT id FROM wisdom_topics WHERE slug = ?", (slug,)).fetchone()
        if existing:
            topic_id = existing[0]
            conn.execute(
                "UPDATE wisdom_topics SET name = ?, summary = ?, message_count = ?, contributor_count = ?, "
                "last_active = ?, updated_at = ? WHERE id = ?",
                (
                    topic_name,
                    summary or None,
                    len(source_message_ids),
                    len(contributors),
                    last_active,
                    now,
                    topic_id,
                ),
            )
        else:
            cursor = conn.execute(
                "INSERT INTO wisdom_topics (name, slug, summary, message_count, contributor_count, "
                "last_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    topic_name,
                    slug,
                    summary or None,
                    len(source_message_ids),
                    len(contributors),
                    last_active,
                    now,
                    now,
                ),
            )
            topic_id = cursor.lastrowid
            topics_created += 1

        seen_titles: set[str] = set()
        for item in items:
            title = item["title"]
            title_key = hashlib.md5(f"{slug}:{title}".lower().encode()).hexdigest()
            if title_key in seen_titles:
                continue
            seen_titles.add(title_key)

            knowledge_type = str(item.get("knowledge_type", "opinion") or "opinion")
            if knowledge_type not in KNOWLEDGE_TYPES:
                knowledge_type = "opinion"

            existing_item = conn.execute(
                "SELECT id FROM wisdom_items WHERE topic_id = ? AND lower(title) = lower(?)",
                (topic_id, title),
            ).fetchone()
            values = (
                knowledge_type,
                item.get("summary", "") or None,
                json.dumps(_normalize_string_list(item.get("links"))),
                json.dumps(item.get("_source_messages", [])),
                json.dumps(_normalize_string_list(item.get("contributors"))),
                float(item.get("confidence", 0.5) or 0.5),
                now,
            )
            if existing_item:
                conn.execute(
                    "UPDATE wisdom_items SET knowledge_type = ?, summary = ?, source_links = ?, "
                    "source_messages = ?, contributors = ?, confidence = ?, updated_at = ? "
                    "WHERE id = ?",
                    (*values, existing_item[0]),
                )
            else:
                conn.execute(
                    "INSERT INTO wisdom_items (topic_id, knowledge_type, title, summary, "
                    "source_links, source_messages, contributors, confidence, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        topic_id,
                        knowledge_type,
                        title,
                        item.get("summary", "") or None,
                        json.dumps(_normalize_string_list(item.get("links"))),
                        json.dumps(item.get("_source_messages", [])),
                        json.dumps(_normalize_string_list(item.get("contributors"))),
                        float(item.get("confidence", 0.5) or 0.5),
                        now,
                        now,
                    ),
                )
            items_saved += 1

        topic_metadata[slug] = {"id": topic_id, "contributors": set(contributors)}

    recommendations_created = 0
    processed_topic_ids = {meta["id"] for meta in topic_metadata.values()}
    if processed_topic_ids:
        placeholders = ",".join("?" for _ in processed_topic_ids)
        conn.execute(
            f"DELETE FROM wisdom_recommendations WHERE from_topic_id IN ({placeholders}) OR to_topic_id IN ({placeholders})",
            [*processed_topic_ids, *processed_topic_ids],
        )

    slugs = list(topic_metadata.keys())
    for index, slug_a in enumerate(slugs):
        for slug_b in slugs[index + 1 :]:
            shared = topic_metadata[slug_a]["contributors"] & topic_metadata[slug_b]["contributors"]
            if len(shared) < 2:
                continue
            reason = f"Shared contributors: {', '.join(sorted(shared)[:5])}"
            strength = min(1.0, len(shared) / 5.0)
            conn.execute(
                "INSERT INTO wisdom_recommendations (from_topic_id, to_topic_id, strength, reason) "
                "VALUES (?, ?, ?, ?)",
                (
                    topic_metadata[slug_a]["id"],
                    topic_metadata[slug_b]["id"],
                    strength,
                    reason,
                ),
            )
            recommendations_created += 1

    latest_timestamp = max(int(msg.get("timestamp", 0) or 0) for msg in messages)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('wisdom_last_run', ?)",
        (str(latest_timestamp),),
    )
    conn.commit()
    conn.close()

    result = {
        "chunks_processed": len(chunks),
        "items_extracted": items_saved,
        "topics_created": topics_created,
        "recommendations_created": recommendations_created,
    }
    logger.info("Wisdom extraction complete: %s", result)
    return result
