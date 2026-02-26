"""Load dossier context for enriching classifier and synthesis prompts."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from vibez.profile import (
    DEFAULT_SUBJECT_NAME,
    get_dossier_path,
    get_subject_name,
    get_subject_possessive,
)

logger = logging.getLogger("vibez.dossier")


def load_dossier(path: Path | None = None) -> dict | None:
    """Load the dossier context.json. Returns None if unavailable."""
    p = path or get_dossier_path()
    if not p.exists():
        logger.warning("Dossier not found at %s", p)
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read dossier: %s", exc)
        return None


def format_dossier_for_classifier(
    dossier: dict, subject_name: str = DEFAULT_SUBJECT_NAME
) -> str:
    """Format dossier context for injection into classifier prompts."""
    resolved_subject = get_subject_name(subject_name)
    subject_possessive = get_subject_possessive(resolved_subject)
    identity = dossier.get("identity", {})
    summary = dossier.get("summary", "")

    lines = [f"{subject_possessive.upper()} EXPERTISE & CONTRIBUTION LENS:"]

    if identity.get("expertise"):
        lines.append(f"Expertise: {identity['expertise']}")
    if identity.get("voice_summary"):
        lines.append(f"Style: {identity['voice_summary'][:300]}")

    if summary:
        lines.append(f"Currently building: {summary[:500]}")

    # Top active projects
    projects = dossier.get("projects", [])
    high = [p for p in projects if p.get("activity_level") == "high"]
    if high:
        proj_lines = []
        for p in high[:5]:
            desc = p.get("description", "")[:80]
            proj_lines.append(f"  - {p['name']} ({p['recent_commits']} commits): {desc}")
        lines.append("Active projects:\n" + "\n".join(proj_lines))

    lines.append(
        "\nWhen flagging contribution opportunities, match against these specific lenses — "
        f"not just topic keywords, but where {subject_possessive} unique perspective adds value."
    )
    return "\n".join(lines)


def format_dossier_for_synthesis(
    dossier: dict, subject_name: str = DEFAULT_SUBJECT_NAME
) -> str:
    """Format dossier context for injection into synthesis prompts."""
    resolved_subject = get_subject_name(subject_name)
    subject_possessive = get_subject_possessive(resolved_subject)
    identity = dossier.get("identity", {})
    summary = dossier.get("summary", "")

    lines = [f"{subject_possessive.upper()} PROFILE (for contribution matching):"]

    if identity.get("voice_summary"):
        lines.append(f"Voice: {identity['voice_summary'][:400]}")
    if identity.get("expertise"):
        lines.append(f"Expertise: {identity['expertise']}")
    if identity.get("thinking"):
        lines.append(f"Thinking approach: {identity['thinking'][:300]}")
    if summary:
        lines.append(f"Current work: {summary[:500]}")

    lines.append(
        f"\nMatch contributions to {subject_possessive} SPECIFIC expertise, not generic 'you could add value here.' "
        f"Draft messages should sound like {resolved_subject} — warm, question-driven, concrete examples, "
        "governance framing, connecting dots across domains."
    )
    return "\n".join(lines)


def get_voice_profile(dossier: dict) -> str:
    """Extract voice profile for draft message generation."""
    identity = dossier.get("identity", {})
    parts = []
    if identity.get("voice_summary"):
        parts.append(identity["voice_summary"])
    if identity.get("expertise"):
        parts.append(f"Expertise areas: {identity['expertise']}")
    return "\n".join(parts) if parts else ""
