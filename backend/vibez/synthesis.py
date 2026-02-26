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
from vibez.dossier import load_dossier, format_dossier_for_synthesis
from vibez.paia_events_adapter import publish_event
from vibez.profile import (
    DEFAULT_SUBJECT_NAME,
    get_subject_name,
    get_subject_possessive,
)
from vibez.semantic_index import get_semantic_arc_hints

logger = logging.getLogger("vibez.synthesis")

SYNTHESIS_SYSTEM_TEMPLATE = """You are {subject_possessive} daily intelligence analyst for the Vibez WhatsApp ecosystem.
You produce structured daily briefings that help {subject_name} stay engaged with minimal reading.
Always respond with valid JSON only. No prose outside the JSON structure."""

SYNTHESIS_TEMPLATE = """Generate today's briefing from {msg_count} messages across {group_count} groups.

{subject_name}'s interest topics: {topics}
{subject_name}'s active projects: {projects}

{dossier_context}

{previous_context}

Messages (chronological, with classifications):
{messages_block}

CONTRIBUTION THEMES from classifier (cluster these):
{contribution_themes_block}

SEMANTIC ARC HINTS (embedding clusters):
{semantic_arc_hints_block}

{subject_messages_block}

Respond with JSON:
{{
  "daily_memo": "<3-5 sentence overarching analysis of how conversations are evolving across groups and why it matters now>",
  "conversation_arcs": [
    {{
      "title": "<conversation arc title>",
      "participants": ["<key people in the exchange>"],
      "core_exchange": "<what people are actually debating/building in this exchange>",
      "why_it_matters": "<why this arc matters for the broader community direction>",
      "likely_next": "<what is likely to happen next in this arc>",
      "how_to_add_value": "<specific way {subject_name} could add value if they enter>"
    }}
  ],
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
      "why": "<why {subject_possessive} SPECIFIC knowledge/projects are relevant — reference their expertise and active work>",
      "action": "<specific suggested action>",
      "draft_message": "<a ready-to-send WhatsApp message written in {subject_name}'s voice. Warm, question-driven, uses concrete examples from their projects. 2-4 sentences. Should sound natural, not robotic.>",
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
      "relevance": "<why it matters to {subject_name}>"
    }}
  ]
}}

CONTRIBUTION RULES:
- Cluster contribution opportunities by THEME, not individual messages.
- A theme with many recent messages is higher priority than one with a single old message.
- "reply" type: fresh threads (<3 days) where {subject_name} can jump in with a direct response.
- "create" type: recurring themes that warrant a dedicated share (tool, deck, post) even if individual messages are older.
- Rank contributions by: theme_relevance * freshness_weight * message_density.
- Focus on the top 3-5 most important threads and top 3-5 contribution themes.

CONVERSATION ARC RULES:
- Conversation arcs should represent actual back-and-forth exchanges, not one-off statements.
- Include only 2-4 arcs with the most strategic signal for {subject_name}.
- Prioritize arcs that reveal how people are thinking, not just what links were shared.

REPLY CONTEXT RULES:
- "channel" MUST be the exact WhatsApp group name from the messages (e.g. "AGI House", "GoodSense Grocers").
- "reply_to" should identify the specific message to reply to: person's name + what they said + approximate time. Include enough context so {subject_name} can scroll to it and long-press to reply.
- For "create" type contributions, channel is where to post and reply_to can be empty.

DRAFT MESSAGE RULES:
- Write as {subject_name} would actually type in WhatsApp — casual, warm, question-driven.
- Reference their real projects and experience where relevant.
- Lead with a question or observation, not "I think you should..."
- Use conversational connective tissue when natural: "so", "right", "kind of", "I think", "you know"
- Keep it 2-4 sentences. Natural, not performative.
- Consider what {subject_name} has already said in the group (see recent messages below) to avoid repeating.

PITHY STYLE RULES (important):
- Keep wording tight and high-signal.
- "insights": max 1-2 short sentences, ~160 chars max.
- "daily_memo": 3-5 short sentences, ~520 chars max.
- "core_exchange": 1-2 short sentences, ~180 chars max.
- "why_it_matters": one short sentence, ~160 chars max.
- "likely_next": one short sentence, ~140 chars max.
- "how_to_add_value": one short sentence, ~140 chars max.
- "why": one short sentence, ~140 chars max.
- "action": one short sentence, ~110 chars max.
- "shifts": one short sentence, ~120 chars max.
- "relevance": one short phrase, ~90 chars max.
- "draft_message": keep to 2-3 short sentences (~320 chars max)."""


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


def get_subject_messages(
    db_path: Path,
    start_ts: int,
    end_ts: int,
    self_aliases: tuple[str, ...] | list[str],
) -> list[dict[str, Any]]:
    """Get subject-authored messages in the time range for context."""
    aliases = [alias.strip().lower() for alias in self_aliases if alias.strip()]
    if not aliases:
        return []
    conn = get_connection(db_path)
    placeholders = ", ".join("?" for _ in aliases)
    cursor = conn.execute(
        f"""SELECT room_name, body, timestamp FROM messages
           WHERE lower(sender_name) IN ({placeholders})
             AND timestamp >= ? AND timestamp < ?
           ORDER BY timestamp DESC LIMIT 20""",
        (*aliases, start_ts, end_ts),
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"room_name": r[0], "body": r[1], "timestamp": r[2]} for r in rows]


def build_synthesis_prompt(
    messages: list[dict[str, Any]],
    value_config: dict[str, Any],
    previous_briefing: str | None = None,
    dossier_context: str = "",
    subject_name: str = DEFAULT_SUBJECT_NAME,
    subject_messages: list[dict[str, Any]] | None = None,
    semantic_arc_hints: list[dict[str, Any]] | None = None,
) -> str:
    """Build the synthesis prompt from classified messages."""
    resolved_subject = get_subject_name(subject_name)
    subject_possessive = get_subject_possessive(resolved_subject)
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

    semantic_arc_hints_block = "  (pgvector hints unavailable)\n"
    if semantic_arc_hints:
        lines: list[str] = []
        for hint in semantic_arc_hints[:6]:
            title = _compact_text(hint.get("title", "semantic thread"), 60)
            momentum = str(hint.get("momentum", "steady"))
            message_count = int(hint.get("message_count", 0) or 0)
            people = int(hint.get("people", 0) or 0)
            quote = _compact_text(hint.get("sample_quote", ""), 200)
            lines.append(
                f"  - {title} | {message_count} msgs | {people} people | {momentum} | {quote}"
            )
        semantic_arc_hints_block = "\n".join(lines) + "\n"

    previous_context = ""
    if previous_briefing:
        previous_context = f"Yesterday's key threads (for continuity):\n{previous_briefing[:1000]}\n"

    # Format subject-authored messages
    subject_messages_block = ""
    if subject_messages:
        subject_messages_block = (
            f"RECENT MESSAGES BY {resolved_subject.upper()} (avoid repeating these):\n"
        )
        for sm in subject_messages[:10]:
            subject_messages_block += f"  [{sm['room_name']}]: {sm['body'][:200]}\n"

    return SYNTHESIS_TEMPLATE.format(
        subject_name=resolved_subject,
        subject_possessive=subject_possessive,
        msg_count=len(messages), group_count=len(groups),
        topics=", ".join(value_config.get("topics", [])),
        projects=", ".join(value_config.get("projects", [])),
        dossier_context=dossier_context,
        previous_context=previous_context, messages_block=messages_block,
        contribution_themes_block=contribution_themes_block,
        semantic_arc_hints_block=semantic_arc_hints_block,
        subject_messages_block=subject_messages_block,
    )


def _compact_text(value: Any, max_chars: int) -> str:
    """Collapse whitespace and trim text to max chars."""
    if value is None:
        return ""
    text = " ".join(str(value).split())
    if len(text) <= max_chars:
        return text
    clipped = text[:max_chars].rsplit(" ", 1)[0].rstrip(" ,;:-")
    if not clipped:
        clipped = text[:max_chars].rstrip(" ,;:-")
    return clipped + "..."


def make_pithy_report(report: dict[str, Any]) -> dict[str, Any]:
    """Normalize synthesis output to concise, scannable fields."""
    pithy: dict[str, Any] = {
        "daily_memo": "",
        "conversation_arcs": [],
        "briefing": [],
        "contributions": [],
        "trends": {"emerging": [], "fading": [], "shifts": ""},
        "links": [],
    }

    pithy["daily_memo"] = _compact_text(report.get("daily_memo", ""), 520)

    for arc in report.get("conversation_arcs", [])[:4]:
        if not isinstance(arc, dict):
            continue
        pithy["conversation_arcs"].append({
            "title": _compact_text(arc.get("title", "Untitled conversation"), 72),
            "participants": [
                _compact_text(participant, 30)
                for participant in (arc.get("participants") or [])[:6]
            ],
            "core_exchange": _compact_text(arc.get("core_exchange", ""), 180),
            "why_it_matters": _compact_text(arc.get("why_it_matters", ""), 160),
            "likely_next": _compact_text(arc.get("likely_next", ""), 140),
            "how_to_add_value": _compact_text(arc.get("how_to_add_value", ""), 140),
        })

    for thread in report.get("briefing", [])[:5]:
        if not isinstance(thread, dict):
            continue
        pithy["briefing"].append({
            "title": _compact_text(thread.get("title", "Untitled"), 68),
            "participants": [
                _compact_text(p, 30)
                for p in (thread.get("participants") or [])[:6]
            ],
            "insights": _compact_text(thread.get("insights", ""), 160),
            "links": [str(link) for link in (thread.get("links") or [])[:5]],
        })

    for contrib in report.get("contributions", [])[:5]:
        if not isinstance(contrib, dict):
            continue
        ctype = contrib.get("type", "reply")
        if ctype not in {"reply", "create"}:
            ctype = "reply"
        freshness = contrib.get("freshness", "warm")
        if freshness not in {"hot", "warm", "cool", "archive"}:
            freshness = "warm"

        pithy["contributions"].append({
            "theme": _compact_text(contrib.get("theme", ""), 48),
            "type": ctype,
            "freshness": freshness,
            "channel": _compact_text(contrib.get("channel", ""), 72),
            "reply_to": _compact_text(contrib.get("reply_to", ""), 220),
            "threads": [
                _compact_text(t, 64)
                for t in (contrib.get("threads") or [])[:4]
            ],
            "why": _compact_text(contrib.get("why", ""), 140),
            "action": _compact_text(contrib.get("action", ""), 110),
            "draft_message": _compact_text(contrib.get("draft_message", ""), 320),
            "message_count": int(contrib.get("message_count", 0) or 0),
        })

    trends = report.get("trends", {}) if isinstance(report.get("trends"), dict) else {}
    pithy["trends"] = {
        "emerging": [_compact_text(t, 56) for t in (trends.get("emerging") or [])[:5]],
        "fading": [_compact_text(t, 56) for t in (trends.get("fading") or [])[:5]],
        "shifts": _compact_text(trends.get("shifts", ""), 120),
    }

    for link in report.get("links", [])[:10]:
        if not isinstance(link, dict):
            continue
        pithy["links"].append({
            "url": str(link.get("url", "")),
            "title": _compact_text(link.get("title", ""), 96),
            "category": _compact_text(link.get("category", ""), 24),
            "relevance": _compact_text(link.get("relevance", ""), 90),
        })

    return pithy


def parse_synthesis_report(raw: str) -> dict[str, Any]:
    """Parse synthesis output JSON with safe defaults."""
    defaults: dict[str, Any] = {
        "daily_memo": "",
        "conversation_arcs": [],
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
           (report_date, briefing_md, briefing_json, contributions, trends, daily_memo, conversation_arcs, stats)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (report_date, briefing_md, json.dumps(report.get("briefing", [])),
         json.dumps(report.get("contributions", [])),
         json.dumps(report.get("trends", {})),
         report.get("daily_memo", ""),
         json.dumps(report.get("conversation_arcs", [])),
         json.dumps(report.get("links", []))),
    )
    conn.commit()
    conn.close()


def render_briefing_markdown(
    report: dict[str, Any],
    report_date: str,
    subject_name: str = DEFAULT_SUBJECT_NAME,
) -> str:
    """Render the synthesis report as readable markdown."""
    resolved_subject = get_subject_name(subject_name)
    lines = [f"# Vibez Daily Briefing — {report_date}\n"]
    if report.get("daily_memo"):
        lines.append("## Daily Memo\n")
        lines.append(f"{report.get('daily_memo', '').strip()}\n")
    if report.get("conversation_arcs"):
        lines.append("## Conversation Arcs\n")
        for i, arc in enumerate(report["conversation_arcs"], 1):
            lines.append(f"### {i}. {arc.get('title', 'Untitled conversation')}")
            participants = ", ".join(arc.get("participants", []))
            if participants:
                lines.append(f"**Participants:** {participants}")
            if arc.get("core_exchange"):
                lines.append(f"\n**Core exchange:** {arc.get('core_exchange', '')}")
            if arc.get("why_it_matters"):
                lines.append(f"\n**Why it matters:** {arc.get('why_it_matters', '')}")
            if arc.get("likely_next"):
                lines.append(f"\n**Likely next:** {arc.get('likely_next', '')}")
            if arc.get("how_to_add_value"):
                lines.append(
                    f"\n**How {resolved_subject} can add value:** {arc.get('how_to_add_value', '')}"
                )
            lines.append("")
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
        return {
            "daily_memo": "",
            "conversation_arcs": [],
            "briefing": [],
            "contributions": [],
            "trends": {},
            "links": [],
        }

    value_cfg = load_value_config(config.db_path)
    previous = get_previous_briefing(config.db_path)
    subject_name = get_subject_name(config.subject_name)
    subject_possessive = get_subject_possessive(subject_name)

    # Load dossier context
    dossier = load_dossier(config.dossier_path)
    dossier_context = (
        format_dossier_for_synthesis(dossier, subject_name=subject_name)
        if dossier
        else ""
    )

    # Load subject-authored messages for context
    subject_msgs = get_subject_messages(
        config.db_path,
        start_ts,
        end_ts,
        config.self_aliases,
    )

    semantic_arc_hints: list[dict[str, Any]] = []
    if config.pgvector_url:
        try:
            semantic_arc_hints = get_semantic_arc_hints(
                config.pgvector_url,
                lookback_hours=24,
                table=config.pgvector_table,
                max_arcs=6,
            )
        except Exception:
            logger.exception("Failed to load semantic arc hints for synthesis prompt")

    prompt = build_synthesis_prompt(
        messages, value_cfg, previous,
        dossier_context=dossier_context,
        subject_name=subject_name,
        subject_messages=subject_msgs,
        semantic_arc_hints=semantic_arc_hints,
    )

    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    response = client.messages.create(
        model=config.synthesis_model, max_tokens=8192,
        system=SYNTHESIS_SYSTEM_TEMPLATE.format(
            subject_name=subject_name,
            subject_possessive=subject_possessive,
        ),
        messages=[{"role": "user", "content": prompt}],
    )
    raw_text = response.content[0].text
    report = make_pithy_report(parse_synthesis_report(raw_text))

    briefing_md = render_briefing_markdown(
        report,
        report_date,
        subject_name=subject_name,
    )
    save_daily_report(config.db_path, report_date, report, briefing_md)
    publish_event(
        "vibez.briefing.generated",
        f"briefing-{report_date}",
        f"vibez:briefing:{report_date}",
        {"date": report_date},
    )

    logger.info("Daily synthesis complete: %d threads, %d contributions",
                len(report.get("briefing", [])), len(report.get("contributions", [])))
    return report
