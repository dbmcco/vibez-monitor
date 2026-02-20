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
from vibez.dossier import load_dossier, format_dossier_for_synthesis, get_voice_profile

logger = logging.getLogger("vibez.synthesis")

SYNTHESIS_SYSTEM = """You are Braydon's daily intelligence analyst for the Vibez WhatsApp ecosystem.
You produce structured daily briefings that help him stay engaged with minimal reading.
Always respond with valid JSON only. No prose outside the JSON structure."""

SYNTHESIS_TEMPLATE = """Generate today's briefing from {msg_count} messages across {group_count} groups.

Braydon's interest topics: {topics}
Braydon's active projects: {projects}

{dossier_context}

{previous_context}

Messages (chronological, with classifications):
{messages_block}

CONTRIBUTION THEMES from classifier (cluster these):
{contribution_themes_block}

{braydon_messages_block}

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
      "theme": "<contribution theme slug, e.g. multi-agent-orchestration>",
      "type": "<'reply' for time-sensitive thread responses, 'create' for evergreen topic contributions>",
      "freshness": "<'hot' if <24h, 'warm' if 1-3 days, 'cool' if 3-7 days, 'archive' if >7 days>",
      "channel": "<exact WhatsApp group name where this reply should go>",
      "reply_to": "<who to reply to and what they said — e.g. 'Dan's message about Maestro enforcing tool discipline via role separation'. Include enough detail to find the message.>",
      "threads": ["<related thread titles from briefing>"],
      "why": "<why Braydon's SPECIFIC knowledge/projects are relevant — reference his expertise and active work>",
      "action": "<specific suggested action>",
      "draft_message": "<a ready-to-send WhatsApp message written in Braydon's voice. Warm, question-driven, uses concrete examples from his projects. 2-4 sentences. Should sound natural, not robotic.>",
      "message_count": <how many messages touched this theme>
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

CONTRIBUTION RULES:
- Cluster contribution opportunities by THEME, not individual messages.
- A theme with many recent messages is higher priority than one with a single old message.
- "reply" type: fresh threads (<3 days) where Braydon can jump in with a direct response.
- "create" type: recurring themes that warrant a dedicated share (tool, deck, post) even if individual messages are older.
- Rank contributions by: theme_relevance * freshness_weight * message_density.
- Focus on the top 3-5 most important threads and top 3-5 contribution themes.

REPLY CONTEXT RULES:
- "channel" MUST be the exact WhatsApp group name from the messages (e.g. "AGI House", "GoodSense Grocers").
- "reply_to" should identify the specific message to reply to: person's name + what they said + approximate time. Include enough context so Braydon can scroll to it and long-press to reply.
- For "create" type contributions, channel is where to post and reply_to can be empty.

DRAFT MESSAGE RULES:
- Write as Braydon would actually type in WhatsApp — casual, warm, question-driven.
- Reference his real projects and experience where relevant.
- Lead with a question or observation, not "I think you should..."
- Use his connective tissue: "so", "right", "kind of", "I think", "you know"
- Keep it 2-4 sentences. Natural, not performative.
- Consider what Braydon has already said in the group (see his recent messages below) to avoid repeating himself."""


def get_day_messages(db_path: Path, start_ts: int, end_ts: int) -> list[dict[str, Any]]:
    """Get all messages with classifications for a time range."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp,
                  c.relevance_score, c.topics, c.entities,
                  c.contribution_flag, c.contribution_hint, c.alert_level,
                  c.contribution_themes
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
            "contribution_themes": json.loads(r[11]) if r[11] else [],
        }
        for r in rows
    ]


def get_braydon_messages(db_path: Path, start_ts: int, end_ts: int) -> list[dict[str, Any]]:
    """Get Braydon's own messages in the time range for context."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        """SELECT room_name, body, timestamp FROM messages
           WHERE sender_name = 'Braydon' AND timestamp >= ? AND timestamp < ?
           ORDER BY timestamp DESC LIMIT 20""",
        (start_ts, end_ts),
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"room_name": r[0], "body": r[1], "timestamp": r[2]} for r in rows]


def build_synthesis_prompt(
    messages: list[dict[str, Any]],
    value_config: dict[str, Any],
    previous_briefing: str | None = None,
    dossier_context: str = "",
    braydon_messages: list[dict[str, Any]] | None = None,
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

    # Aggregate contribution themes across all messages
    theme_counts: dict[str, int] = {}
    for m in messages:
        for theme in m.get("contribution_themes", []):
            theme_counts[theme] = theme_counts.get(theme, 0) + 1
    contribution_themes_block = ""
    if theme_counts:
        for theme, count in sorted(theme_counts.items(), key=lambda x: -x[1]):
            contribution_themes_block += f"  {theme}: {count} messages\n"
    else:
        contribution_themes_block = "  (none flagged yet)\n"

    previous_context = ""
    if previous_briefing:
        previous_context = f"Yesterday's key threads (for continuity):\n{previous_briefing[:1000]}\n"

    # Format Braydon's own messages
    braydon_messages_block = ""
    if braydon_messages:
        braydon_messages_block = "BRAYDON'S RECENT MESSAGES (avoid repeating these):\n"
        for bm in braydon_messages[:10]:
            braydon_messages_block += f"  [{bm['room_name']}]: {bm['body'][:200]}\n"

    return SYNTHESIS_TEMPLATE.format(
        msg_count=len(messages), group_count=len(groups),
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        dossier_context=dossier_context,
        previous_context=previous_context, messages_block=messages_block,
        contribution_themes_block=contribution_themes_block,
        braydon_messages_block=braydon_messages_block,
    )


def parse_synthesis_report(raw: str) -> dict[str, Any]:
    """Parse synthesis output JSON with safe defaults."""
    defaults: dict[str, Any] = {
        "briefing": [], "contributions": [],
        "trends": {"emerging": [], "fading": [], "shifts": ""}, "links": [],
    }
    try:
        cleaned = raw.strip()
        # Strip markdown code fences (closed or truncated)
        import re
        fence_match = re.search(r"```(?:json)?\s*\n(.*?)(?:```|$)", cleaned, re.DOTALL)
        if fence_match:
            cleaned = fence_match.group(1)
        cleaned = cleaned.strip()
        # Try parsing as-is first
        try:
            data = json.loads(cleaned)
            return {**defaults, **data}
        except json.JSONDecodeError:
            pass
        # If truncated, try to repair by closing braces
        repair = cleaned
        open_braces = repair.count("{") - repair.count("}")
        open_brackets = repair.count("[") - repair.count("]")
        if open_braces > 0 or open_brackets > 0:
            # Truncate to last complete object/array element
            for _ in range(open_brackets):
                repair += "]"
            for _ in range(open_braces):
                repair += "}"
            try:
                data = json.loads(repair)
                logger.info("Repaired truncated JSON (%d braces, %d brackets added)", open_braces, open_brackets)
                return {**defaults, **data}
            except json.JSONDecodeError:
                pass
        logger.warning("Failed to parse synthesis report: %s", raw[:200])
        return defaults
    except Exception:
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
            # briefing_json is stored as a direct array of thread objects
            threads = data if isinstance(data, list) else data.get("briefing", [])
            titles = [t.get("title", "") for t in threads if isinstance(t, dict)]
            return "Previous threads: " + ", ".join(titles)
        except (json.JSONDecodeError, AttributeError):
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
            ctype = c.get("type", "reply")
            freshness = c.get("freshness", "")
            theme = c.get("theme", "")
            badge = f"[{ctype.upper()}]" if ctype else ""
            fresh_badge = f"[{freshness}]" if freshness else ""
            lines.append(f"### {badge} {fresh_badge} {theme}")
            if c.get("threads"):
                lines.append(f"**Related threads:** {', '.join(c['threads'])}")
            lines.append(f"\n{c.get('why', '')}")
            lines.append(f"\n**Action:** {c.get('action', '')}")
            if c.get("draft_message"):
                lines.append(f"\n**Draft message:**\n> {c['draft_message']}")
            if c.get("message_count"):
                lines.append(f"*({c['message_count']} messages on this theme)*")
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

    # Load dossier context
    dossier = load_dossier()
    dossier_context = format_dossier_for_synthesis(dossier) if dossier else ""

    # Load Braydon's own messages for context
    braydon_msgs = get_braydon_messages(config.db_path, start_ts, end_ts)

    prompt = build_synthesis_prompt(
        messages, value_cfg, previous,
        dossier_context=dossier_context,
        braydon_messages=braydon_msgs,
    )

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    response = client.messages.create(
        model=config.synthesis_model, max_tokens=8192,
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
