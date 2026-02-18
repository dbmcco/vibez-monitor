"""Sonnet-based message classifier for the attention firewall."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection

logger = logging.getLogger("vibez.classifier")

CLASSIFY_SYSTEM = """You are a message classifier for Braydon's WhatsApp attention firewall.
You classify messages by relevance to Braydon's interests and identify contribution opportunities.
Always respond with valid JSON only. No prose, no markdown fences."""

CLASSIFY_TEMPLATE = """Classify this WhatsApp message.

Braydon's interest topics: {topics}
Braydon's active projects: {projects}

Message:
  From: {sender_name}
  Group: {room_name}
  Text: {body}

Recent thread context:
{context}

Respond with JSON:
{{
  "relevance_score": <0-10, how relevant to Braydon's interests>,
  "topics": [<topic tags from the message>],
  "entities": [<tools, repos, concepts, people mentioned>],
  "contribution_flag": <true if Braydon could add value>,
  "contribution_hint": "<if flagged, why and what could he contribute>",
  "alert_level": "<'hot' if needs attention now, 'digest' if include in daily summary, 'none' if low value>"
}}"""


def build_classify_prompt(
    message: dict[str, Any],
    value_config: dict[str, Any],
    context_messages: list[dict[str, Any]] | None = None,
) -> str:
    """Build the classification prompt for a single message."""
    context_lines = ""
    if context_messages:
        for cm in context_messages[-3:]:
            context_lines += f"  {cm.get('sender_name', '?')}: {cm.get('body', '')}\n"
    if not context_lines:
        context_lines = "  (no recent context)"

    return CLASSIFY_TEMPLATE.format(
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        sender_name=message.get("sender_name", "Unknown"),
        room_name=message.get("room_name", "Unknown"),
        body=message.get("body", ""),
        context=context_lines,
    )


def parse_classification(raw: str) -> dict[str, Any]:
    """Parse classifier output JSON, with safe defaults on failure."""
    defaults = {
        "relevance_score": 0,
        "topics": [],
        "entities": [],
        "contribution_flag": False,
        "contribution_hint": "",
        "alert_level": "none",
    }
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        cleaned = cleaned.strip()

        data = json.loads(cleaned)
        result = {**defaults, **data}
        result["relevance_score"] = max(0, min(10, int(result["relevance_score"])))
        if result["alert_level"] not in ("hot", "digest", "none"):
            result["alert_level"] = "none"
        result["contribution_flag"] = bool(result["contribution_flag"])
        return result
    except (json.JSONDecodeError, KeyError, ValueError):
        logger.warning("Failed to parse classification: %s", raw[:200])
        return defaults


def load_value_config(db_path: Path) -> dict[str, Any]:
    """Load value configuration from the database."""
    conn = get_connection(db_path)
    cursor = conn.execute("SELECT key, value FROM value_config")
    config = {}
    for key, value in cursor.fetchall():
        config[key] = json.loads(value)
    conn.close()
    return config


def get_recent_context(db_path: Path, room_id: str, before_ts: int, limit: int = 3) -> list[dict]:
    """Get recent messages in the same room for thread context."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT sender_name, body FROM messages
           WHERE room_id = ? AND timestamp < ?
           ORDER BY timestamp DESC LIMIT ?""",
        (room_id, before_ts, limit),
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"sender_name": r[0], "body": r[1]} for r in reversed(rows)]


def save_classification(db_path: Path, message_id: str, classification: dict[str, Any]) -> None:
    """Save a classification result to the database."""
    conn = get_connection(db_path)
    conn.execute(
        """INSERT OR REPLACE INTO classifications
           (message_id, relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            message_id,
            classification["relevance_score"],
            json.dumps(classification["topics"]),
            json.dumps(classification["entities"]),
            classification["contribution_flag"],
            classification["contribution_hint"],
            classification["alert_level"],
        ),
    )
    conn.commit()
    conn.close()


def write_hot_alert(db_path: Path, message: dict, classification: dict) -> None:
    """Write a hot alert to a JSON file the dashboard can watch."""
    alerts_path = db_path.parent / "hot_alerts.json"
    alerts = []
    if alerts_path.exists():
        try:
            alerts = json.loads(alerts_path.read_text())
        except json.JSONDecodeError:
            alerts = []
    alerts.append(
        {
            "message_id": message["id"],
            "sender_name": message.get("sender_name", ""),
            "room_name": message.get("room_name", ""),
            "body": message.get("body", ""),
            "timestamp": message.get("timestamp", 0),
            "relevance_score": classification["relevance_score"],
            "contribution_hint": classification.get("contribution_hint", ""),
        }
    )
    alerts = alerts[-50:]
    alerts_path.write_text(json.dumps(alerts, indent=2))


async def classify_messages(config: Config, messages: list[dict[str, Any]]) -> None:
    """Classify a batch of messages using Sonnet."""
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    value_cfg = load_value_config(config.db_path)

    for msg in messages:
        try:
            context = get_recent_context(config.db_path, msg["room_id"], msg["timestamp"])
            prompt = build_classify_prompt(msg, value_cfg, context)

            response = client.messages.create(
                model=config.classifier_model,
                max_tokens=256,
                system=CLASSIFY_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
            raw_text = response.content[0].text
            classification = parse_classification(raw_text)

            save_classification(config.db_path, msg["id"], classification)

            if classification["alert_level"] == "hot":
                write_hot_alert(config.db_path, msg, classification)
                logger.info(
                    "HOT ALERT: %s in %s (score=%d): %s",
                    msg.get("sender_name"),
                    msg.get("room_name"),
                    classification["relevance_score"],
                    classification.get("contribution_hint", ""),
                )
            else:
                logger.debug(
                    "Classified %s: score=%d level=%s",
                    msg["id"],
                    classification["relevance_score"],
                    classification["alert_level"],
                )
        except Exception:
            logger.exception("Failed to classify message %s", msg.get("id"))
