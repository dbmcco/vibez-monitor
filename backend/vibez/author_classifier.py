# ABOUTME: LLM-based authorship enrichment for links.
# ABOUTME: Classifies whether a link was authored (written/created) by a group member vs just shared.

"""Authorship enrichment: determine if a shared link was created by a group member."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import anthropic

from vibez.budget_guard import check_budget, record_usage
from vibez.db import get_connection

logger = logging.getLogger("vibez.author_classifier")

# How many chars of context to feed per link
_SNIPPET_LIMIT = 600

SYSTEM_PROMPT = (
    "You are a classifier that determines whether a link was authored (written, created, or published) "
    "by the person who shared it in a group chat, or whether they simply found and shared it. "
    "Respond with valid JSON only. No prose, no markdown fences."
)

USER_PROMPT = """A group member named "{sender}" shared this link in a group chat.

URL: {url}
Message context (what they said when sharing):
{context}

Group members in this chat: {members}

Determine:
1. Did "{sender}" author/write/create this content? Consider signals like:
   - They explicitly say "my post", "I wrote", "check out my article", "our project", "I built this", etc.
   - The URL contains their name or a known handle (e.g. their name in the domain, github.com/theirname)
   - They describe it in first-person as something they made
   - They ask for feedback on it as their own work
2. If authored, return their name exactly as it appears in the member list.
3. If just sharing someone else's content, return null.

Respond with JSON:
{{"authored_by": "<member name or null>", "confidence": "<high|medium|low>", "reason": "<one sentence>"}}"""


def _name_tokens(name: str) -> list[str]:
    """Return lowercase tokens from a display name (split on space, comma, dot)."""
    return [t.lower() for t in re.split(r"[\s,.\-_]+", name) if len(t) >= 3]


def _url_heuristic(url: str, sender: str) -> str | None:
    """Return sender name if URL strongly suggests they authored it, else None."""
    try:
        parsed = urlparse(url.lower())
        host = parsed.netloc.replace("www.", "")
        path = parsed.path
    except Exception:
        return None

    tokens = _name_tokens(sender)
    for token in tokens:
        # Substack: token.substack.com
        if f"{token}.substack.com" in host:
            return sender
        # GitHub: github.com/token/...
        if "github.com" in host and path.startswith(f"/{token}/"):
            return sender
        # Personal domain: token.com or token.dev etc.
        if host.startswith(f"{token}.") or host == token:
            return sender
        # Medium: medium.com/@token
        if "medium.com" in host and f"/@{token}" in path:
            return sender
        # Dev.to, hashnode: dev.to/token
        if host in {"dev.to", "hashnode.com"} and path.startswith(f"/{token}"):
            return sender
    return None


def _get_group_members(db_path: Path) -> list[str]:
    """Derive group member roster from distinct sender names in messages table."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT DISTINCT sender_name FROM messages WHERE sender_name NOT LIKE '+%' ORDER BY sender_name"
    ).fetchall()
    conn.close()
    return [r[0] for r in rows if r[0]]


def _get_unclassified_links(db_path: Path, limit: int = 500) -> list[dict[str, Any]]:
    """Return links where authored_by has not been set yet."""
    conn = get_connection(db_path)
    rows = conn.execute(
        """SELECT id, url, shared_by, relevance FROM links
           WHERE authored_by IS NULL AND shared_by IS NOT NULL AND shared_by != ''
           ORDER BY last_seen DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    conn.close()
    return [{"id": r[0], "url": r[1], "shared_by": r[2], "relevance": r[3]} for r in rows]


def _save_authored_by(db_path: Path, link_id: int, authored_by: str | None) -> None:
    # Store empty string for "checked, not authored" so we don't re-process it
    value = authored_by if authored_by else ""
    conn = get_connection(db_path)
    conn.execute("UPDATE links SET authored_by = ? WHERE id = ?", (value, link_id))
    conn.commit()
    conn.close()


def enrich_link_authors(
    db_path: Path,
    api_key: str,
    model: str = "claude-haiku-4-5-20251001",
    limit: int = 500,
    daily_budget_usd: float = 10.0,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    Enrich links with authorship data.

    Returns counts: {"heuristic": N, "llm": N, "skipped_budget": N, "total": N}
    """
    links = _get_unclassified_links(db_path, limit)
    if not links:
        logger.info("No unclassified links to process.")
        return {"heuristic": 0, "llm": 0, "skipped_budget": 0, "total": 0}

    members = _get_group_members(db_path)
    members_str = ", ".join(members) if members else "unknown"

    client = anthropic.Anthropic(api_key=api_key)
    counts = {"heuristic": 0, "llm": 0, "skipped_budget": 0, "total": len(links)}

    for link in links:
        sender = link["shared_by"] or ""
        # shared_by may be comma-separated (multiple sharers); take first
        primary_sender = sender.split(",")[0].strip()
        if not primary_sender:
            _save_authored_by(db_path, link["id"], None)
            continue

        # --- URL heuristic first (free) ---
        heuristic_result = _url_heuristic(link["url"], primary_sender)
        if heuristic_result is not None:
            logger.debug("Heuristic match: %s authored %s", primary_sender, link["url"])
            if not dry_run:
                _save_authored_by(db_path, link["id"], primary_sender)
            counts["heuristic"] += 1
            continue

        # --- LLM classification ---
        allowed, spent = check_budget(db_path, daily_budget_usd)
        if not allowed:
            logger.warning("Budget limit reached ($%.2f spent), stopping.", spent)
            counts["skipped_budget"] += counts["total"] - counts["heuristic"] - counts["llm"]
            break

        context = (link["relevance"] or "")[:_SNIPPET_LIMIT].strip() or "(no context)"
        prompt = USER_PROMPT.format(
            sender=primary_sender,
            url=link["url"],
            context=context,
            members=members_str,
        )

        try:
            response = client.messages.create(
                model=model,
                max_tokens=128,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = response.content[0].text.strip()
            # Strip think blocks and markdown fences if present
            raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            raw = re.sub(r"^```(?:json)?\s*", "", raw).rstrip("`").strip()
            if hasattr(response, "usage") and response.usage:
                record_usage(db_path, model, response.usage.input_tokens, response.usage.output_tokens)

            parsed = json.loads(raw)
            authored_by = parsed.get("authored_by") or None
            confidence = parsed.get("confidence", "")
            reason = parsed.get("reason", "")

            # Discard low-confidence positives
            if authored_by and confidence == "low":
                authored_by = None

            logger.debug(
                "LLM: %s | authored_by=%s | confidence=%s | %s",
                link["url"], authored_by, confidence, reason,
            )
            if not dry_run:
                _save_authored_by(db_path, link["id"], authored_by)
            counts["llm"] += 1

        except (json.JSONDecodeError, KeyError, IndexError) as exc:
            logger.warning("Failed to parse LLM response for link %d: %s", link["id"], exc)
            if not dry_run:
                _save_authored_by(db_path, link["id"], None)
            counts["llm"] += 1

    return counts
