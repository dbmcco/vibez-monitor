"""Load dossier context for enriching classifier and synthesis prompts."""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("vibez.dossier")

DOSSIER_PATH = Path.home() / ".dossier" / "context.json"


def load_dossier(path: Path | None = None) -> dict | None:
    """Load the dossier context.json. Returns None if unavailable."""
    p = path or DOSSIER_PATH
    if not p.exists():
        logger.warning("Dossier not found at %s", p)
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read dossier: %s", exc)
        return None


def format_dossier_for_classifier(dossier: dict) -> str:
    """Format dossier context for injection into classifier prompts."""
    identity = dossier.get("identity", {})
    summary = dossier.get("summary", "")

    lines = ["BRAYDON'S EXPERTISE & CONTRIBUTION LENS:"]

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
        "not just topic keywords, but where Braydon's unique perspective adds value."
    )
    return "\n".join(lines)


def format_dossier_for_synthesis(dossier: dict) -> str:
    """Format dossier context for injection into synthesis prompts."""
    identity = dossier.get("identity", {})
    summary = dossier.get("summary", "")

    lines = ["BRAYDON'S PROFILE (for contribution matching):"]

    if identity.get("voice_summary"):
        lines.append(f"Voice: {identity['voice_summary'][:400]}")
    if identity.get("expertise"):
        lines.append(f"Expertise: {identity['expertise']}")
    if identity.get("thinking"):
        lines.append(f"Thinking approach: {identity['thinking'][:300]}")
    if summary:
        lines.append(f"Current work: {summary[:500]}")

    lines.append(
        "\nMatch contributions to his SPECIFIC expertise, not generic 'you could add value here.' "
        "Draft messages should sound like him — warm, question-driven, concrete examples, "
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
