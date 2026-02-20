"""Chat agent for answering questions about the WhatsApp chat content."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection
from vibez.dossier import load_dossier, get_voice_profile

logger = logging.getLogger("vibez.chat_agent")

CHAT_SYSTEM = """You are Braydon's chat analyst for the Vibez WhatsApp ecosystem.
You answer questions about what's happening in the group chats, who said what,
trending topics, and help Braydon understand conversations he may have missed.

Be concise, specific, and cite who said what when relevant. If you don't have
enough context to answer, say so clearly."""


def search_messages(
    db_path: Path,
    query: str,
    lookback_days: int = 7,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search messages relevant to a query using full-text matching."""
    conn = get_connection(db_path)
    cutoff_ts = int((datetime.now() - timedelta(days=lookback_days)).timestamp() * 1000)

    # Split query into keywords for LIKE matching
    keywords = [w.strip() for w in query.lower().split() if len(w.strip()) > 2]

    if not keywords:
        # Fall back to recent high-relevance messages
        cursor = conn.execute(
            """SELECT m.room_name, m.sender_name, m.body, m.timestamp,
                      c.relevance_score, c.topics, c.contribution_hint
               FROM messages m
               LEFT JOIN classifications c ON m.id = c.message_id
               WHERE m.timestamp >= ?
               ORDER BY c.relevance_score DESC NULLS LAST
               LIMIT ?""",
            (cutoff_ts, limit),
        )
    else:
        # Build WHERE clause with keyword matching
        where_parts = []
        params: list[Any] = [cutoff_ts]
        for kw in keywords[:5]:
            where_parts.append("LOWER(m.body) LIKE ?")
            params.append(f"%{kw}%")

        cursor = conn.execute(
            f"""SELECT m.room_name, m.sender_name, m.body, m.timestamp,
                       c.relevance_score, c.topics, c.contribution_hint
                FROM messages m
                LEFT JOIN classifications c ON m.id = c.message_id
                WHERE m.timestamp >= ? AND ({' OR '.join(where_parts)})
                ORDER BY m.timestamp DESC
                LIMIT ?""",
            (*params, limit),
        )

    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "room_name": r[0], "sender_name": r[1], "body": r[2],
            "timestamp": r[3], "relevance_score": r[4] or 0,
            "topics": json.loads(r[5]) if r[5] else [],
            "contribution_hint": r[6] or "",
        }
        for r in rows
    ]


def get_recent_summary(db_path: Path) -> str:
    """Get the latest daily report summary for context."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        "SELECT briefing_md, report_date FROM daily_reports ORDER BY report_date DESC LIMIT 1"
    )
    row = cursor.fetchone()
    conn.close()
    if row and row[0]:
        return f"Latest briefing ({row[1]}):\n{row[0][:2000]}"
    return ""


async def chat(config: Config, question: str, lookback_days: int = 7) -> str:
    """Answer a question about the chat content."""
    # Search for relevant messages
    messages = search_messages(config.db_path, question, lookback_days)

    # Get latest briefing for high-level context
    briefing_context = get_recent_summary(config.db_path)

    # Load dossier for profile context
    dossier = load_dossier()
    voice = get_voice_profile(dossier) if dossier else ""

    # Build context block
    msg_block = ""
    for m in messages:
        ts = datetime.fromtimestamp(m["timestamp"] / 1000).strftime("%Y-%m-%d %H:%M")
        msg_block += f"[{ts}] [{m['room_name']}] {m['sender_name']}: {m['body'][:300]}\n"

    if not msg_block:
        msg_block = "(no matching messages found)"

    prompt = f"""Question: {question}

{briefing_context}

Relevant messages from the last {lookback_days} days:
{msg_block}

Answer the question based on the messages above. Be specific — cite who said what,
which group it was in, and when. If the question is about contribution opportunities,
suggest concrete actions."""

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    response = client.messages.create(
        model=config.synthesis_model,
        max_tokens=1024,
        system=CHAT_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text
