"""Daily synthesis agent — generates morning briefings and contribution maps."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import anthropic

from vibez.config import Config
from vibez.db import get_connection, init_db

logger = logging.getLogger("vibez.synthesis")

SYNTHESIS_SYSTEM = """You are Braydon's daily intelligence analyst for the Vibez WhatsApp ecosystem.
You produce structured daily briefings that help him stay engaged with minimal reading.
Always respond with valid JSON only. No prose outside the JSON structure."""

SYNTHESIS_TEMPLATE = """Generate today's briefing from {msg_count} messages across {group_count} groups.

Braydon's interest topics: {topics}
Braydon's active projects: {projects}

{previous_context}

Messages (chronological, with classifications):
{messages_block}

Respond with JSON:
{{
  "briefing": [
    {{
      "title": "<thread/topic title>",
      "participants": ["<key people>"],
      "insights": "<1-2 sentence summary of what happened/was decided>",
      "links": ["<any URLs shared>"]
    }}
  ],
  "contributions": [
    {{
      "thread": "<which thread>",
      "why": "<why Braydon's knowledge is relevant>",
      "action": "<specific suggested action>"
    }}
  ],
  "trends": {{
    "emerging": ["<new topics gaining traction>"],
    "fading": ["<topics losing steam>"],
    "shifts": "<1 sentence on what changed this week>"
  }},
  "links": [
    {{
      "url": "<link>",
      "title": "<what it is>",
      "category": "<tool|repo|article|discussion>",
      "relevance": "<why it matters to Braydon>"
    }}
  ]
}}

Focus on the top 3-5 most important threads. Be specific about contribution opportunities."""


def get_day_messages(db_path: Path, start_ts: int, end_ts: int) -> list[dict[str, Any]]:
    """Get all messages with classifications for a time range."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp,
                  c.relevance_score, c.topics, c.entities,
                  c.contribution_flag, c.contribution_hint, c.alert_level
           FROM messages m
           LEFT JOIN classifications c ON m.id = c.message_id
           WHERE m.timestamp >= ? AND m.timestamp < ?
           ORDER BY m.timestamp ASC""",
        (start_ts, end_ts),
    )
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "id": r[0], "room_name": r[1], "sender_name": r[2], "body": r[3],
            "timestamp": r[4], "relevance_score": r[5] or 0,
            "topics": json.loads(r[6]) if r[6] else [],
            "entities": json.loads(r[7]) if r[7] else [],
            "contribution_flag": bool(r[8]),
            "contribution_hint": r[9] or "", "alert_level": r[10] or "none",
        }
        for r in rows
    ]


def build_synthesis_prompt(
    messages: list[dict[str, Any]],
    value_config: dict[str, Any],
    previous_briefing: str | None = None,
) -> str:
    """Build the synthesis prompt from classified messages."""
    groups = set(m["room_name"] for m in messages)

    messages_block = ""
    for m in messages:
        ts = datetime.fromtimestamp(m["timestamp"] / 1000).strftime("%H:%M")
        score = m.get("relevance_score", 0)
        flag = " [CONTRIBUTION OPP]" if m.get("contribution_flag") else ""
        messages_block += (
            f"  [{ts}] [{m['room_name']}] {m['sender_name']} (rel={score}{flag}): "
            f"{m['body'][:500]}\n"
        )

    previous_context = ""
    if previous_briefing:
        previous_context = f"Yesterday's key threads (for continuity):\n{previous_briefing[:1000]}\n"

    return SYNTHESIS_TEMPLATE.format(
        msg_count=len(messages), group_count=len(groups),
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        previous_context=previous_context, messages_block=messages_block,
    )


def parse_synthesis_report(raw: str) -> dict[str, Any]:
    """Parse synthesis output JSON with safe defaults."""
    defaults: dict[str, Any] = {
        "briefing": [], "contributions": [],
        "trends": {"emerging": [], "fading": [], "shifts": ""}, "links": [],
    }
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        data = json.loads(cleaned.strip())
        return {**defaults, **data}
    except (json.JSONDecodeError, KeyError):
        logger.warning("Failed to parse synthesis report: %s", raw[:200])
        return defaults


def get_previous_briefing(db_path: Path) -> str | None:
    """Get yesterday's briefing for continuity context."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        "SELECT briefing_json FROM daily_reports ORDER BY report_date DESC LIMIT 1"
    )
    row = cursor.fetchone()
    conn.close()
    if row and row[0]:
        try:
            data = json.loads(row[0])
            titles = [t.get("title", "") for t in data.get("briefing", [])]
            return "Previous threads: " + ", ".join(titles)
        except json.JSONDecodeError:
            pass
    return None


def save_daily_report(db_path: Path, report_date: str, report: dict[str, Any], briefing_md: str) -> None:
    """Save the daily synthesis report."""
    conn = get_connection(db_path)
    conn.execute(
        """INSERT OR REPLACE INTO daily_reports
           (report_date, briefing_md, briefing_json, contributions, trends, stats)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (report_date, briefing_md, json.dumps(report.get("briefing", [])),
         json.dumps(report.get("contributions", [])),
         json.dumps(report.get("trends", {})),
         json.dumps(report.get("links", []))),
    )
    conn.commit()
    conn.close()


def render_briefing_markdown(report: dict[str, Any], report_date: str) -> str:
    """Render the synthesis report as readable markdown."""
    lines = [f"# Vibez Daily Briefing — {report_date}\n"]
    if report.get("briefing"):
        lines.append("## Key Threads\n")
        for i, thread in enumerate(report["briefing"], 1):
            lines.append(f"### {i}. {thread.get('title', 'Untitled')}")
            participants = ", ".join(thread.get("participants", []))
            if participants:
                lines.append(f"**Participants:** {participants}")
            lines.append(f"\n{thread.get('insights', '')}\n")
            for link in thread.get("links", []):
                lines.append(f"- {link}")
            lines.append("")
    if report.get("contributions"):
        lines.append("## Contribution Opportunities\n")
        for c in report["contributions"]:
            lines.append(f"- **{c.get('thread', '')}**: {c.get('why', '')}")
            lines.append(f"  - Action: {c.get('action', '')}")
        lines.append("")
    trends = report.get("trends", {})
    if trends:
        lines.append("## Trends\n")
        if trends.get("emerging"):
            lines.append(f"**Emerging:** {', '.join(trends['emerging'])}")
        if trends.get("fading"):
            lines.append(f"**Fading:** {', '.join(trends['fading'])}")
        if trends.get("shifts"):
            lines.append(f"\n{trends['shifts']}")
        lines.append("")
    if report.get("links"):
        lines.append("## Links Shared\n")
        for link in report["links"]:
            lines.append(f"- [{link.get('title', link.get('url', ''))}]({link.get('url', '')})"
                        f" ({link.get('category', '')}) — {link.get('relevance', '')}")
    return "\n".join(lines)


async def run_daily_synthesis(config: Config) -> dict[str, Any]:
    """Run the daily synthesis for the last 24 hours."""
    from vibez.classifier import load_value_config

    init_db(config.db_path)

    now = datetime.now()
    start = now - timedelta(hours=24)
    start_ts = int(start.timestamp() * 1000)
    end_ts = int(now.timestamp() * 1000)
    report_date = now.strftime("%Y-%m-%d")

    messages = get_day_messages(config.db_path, start_ts, end_ts)
    if not messages:
        logger.info("No messages in the last 24 hours. Skipping synthesis.")
        return {"briefing": [], "contributions": [], "trends": {}, "links": []}

    value_cfg = load_value_config(config.db_path)
    previous = get_previous_briefing(config.db_path)
    prompt = build_synthesis_prompt(messages, value_cfg, previous)

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    response = client.messages.create(
        model=config.synthesis_model, max_tokens=4096,
        system=SYNTHESIS_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    raw_text = response.content[0].text
    report = parse_synthesis_report(raw_text)

    briefing_md = render_briefing_markdown(report, report_date)
    save_daily_report(config.db_path, report_date, report, briefing_md)

    logger.info("Daily synthesis complete: %d threads, %d contributions",
                len(report.get("briefing", [])), len(report.get("contributions", [])))
    return report
