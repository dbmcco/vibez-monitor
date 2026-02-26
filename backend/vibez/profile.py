"""Profile identity helpers for subject-specific prompt and matching behavior."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

DEFAULT_SUBJECT_NAME = "User"
DEFAULT_SUBJECT_ALIASES: tuple[str, ...] = ()
DEFAULT_DOSSIER_PATH = Path.home() / ".dossier" / "context.json"


def get_subject_name(raw_name: str | None = None) -> str:
    """Resolve the configured subject name with backward-compatible default."""
    value = raw_name if raw_name is not None else os.environ.get("VIBEZ_SUBJECT_NAME", "")
    cleaned = value.strip()
    return cleaned or DEFAULT_SUBJECT_NAME


def get_subject_possessive(subject_name: str) -> str:
    """Return possessive form of the subject name (e.g., James' / Alex's)."""
    cleaned = subject_name.strip() or DEFAULT_SUBJECT_NAME
    if cleaned.lower().endswith("s"):
        return f"{cleaned}'"
    return f"{cleaned}'s"


def _normalize_aliases(values: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    aliases: list[str] = []
    for value in values:
        cleaned = value.strip()
        key = cleaned.casefold()
        if not cleaned or key in seen:
            continue
        seen.add(key)
        aliases.append(cleaned)
    return tuple(aliases)


def _parse_aliases_csv(raw_aliases: str) -> tuple[str, ...]:
    return _normalize_aliases(raw_aliases.split(","))


def get_self_aliases(
    subject_name: str | None = None,
    raw_aliases: str | None = None,
) -> tuple[str, ...]:
    """Return configured aliases that should be treated as the subject."""
    resolved_subject = get_subject_name(subject_name)
    raw = raw_aliases
    if raw is None:
        raw = os.environ.get("VIBEZ_SELF_ALIASES")

    aliases: list[str] = [resolved_subject]
    if raw is not None:
        aliases.extend(_parse_aliases_csv(raw))
    elif resolved_subject.casefold() == DEFAULT_SUBJECT_NAME.casefold():
        aliases.extend(DEFAULT_SUBJECT_ALIASES)

    return _normalize_aliases(aliases)


def get_dossier_path(raw_path: str | None = None) -> Path:
    """Resolve the dossier path, defaulting to ~/.dossier/context.json."""
    value = raw_path if raw_path is not None else os.environ.get("VIBEZ_DOSSIER_PATH", "")
    cleaned = value.strip()
    if cleaned:
        return Path(cleaned).expanduser()
    return DEFAULT_DOSSIER_PATH
