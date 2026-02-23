# ABOUTME: Tests for paia-events adapter — verifies envelope construction
# ABOUTME: and fire-and-forget behavior when paia-events is unreachable.

import json
from unittest.mock import patch, MagicMock

from vibez.paia_events_adapter import publish_event


def test_publish_constructs_valid_envelope():
    with patch("vibez.paia_events_adapter.urlopen") as mock:
        mock.return_value = MagicMock()
        publish_event(
            "vibez.messages.synced",
            "sync-123",
            "vibez:sync:123",
            {"count": 5, "room": "The Vibez"},
        )
        req = mock.call_args[0][0]
        body = json.loads(req.data)
        assert body["event_type"] == "vibez.messages.synced"
        assert body["source_app"] == "vibez-monitor"
        assert body["dedupe_key"] == "vibez:sync:123"
        assert "occurred_at" in body


def test_publish_does_not_raise_on_failure():
    with patch("vibez.paia_events_adapter.urlopen", side_effect=Exception("refused")):
        publish_event("vibez.alert.hot", "a-1", "vibez:a-1", {"msg": "test"})


def test_publish_includes_payload():
    with patch("vibez.paia_events_adapter.urlopen") as mock:
        mock.return_value = MagicMock()
        publish_event(
            "vibez.briefing.generated",
            "briefing-2026-02-23",
            "vibez:briefing:2026-02-23",
            {"date": "2026-02-23"},
        )
        req = mock.call_args[0][0]
        body = json.loads(req.data)
        assert body["payload"]["date"] == "2026-02-23"
