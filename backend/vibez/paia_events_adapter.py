# ABOUTME: Fire-and-forget event publisher for paia-events fabric.
# ABOUTME: Publishes vibez events (message sync, classification, alerts) without blocking.

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger(__name__)

PAIA_EVENTS_URL = os.environ.get("PAIA_EVENTS_URL", "http://localhost:3511/v1/events")


def publish_event(
    event_type: str,
    source_event_id: str,
    dedupe_key: str,
    payload: dict[str, Any],
) -> None:
    """Fire-and-forget event publish to paia-events. Never raises."""
    try:
        envelope = {
            "event_type": event_type,
            "source_app": "vibez-monitor",
            "source_event_id": source_event_id,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "dedupe_key": dedupe_key,
            "payload": payload,
        }
        req = Request(
            PAIA_EVENTS_URL,
            data=json.dumps(envelope).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urlopen(req, timeout=3)
    except (URLError, OSError, Exception):
        logger.debug("paia-events publish failed (service may be down)")
