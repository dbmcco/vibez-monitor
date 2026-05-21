import asyncio

import pytest

from vibez import beeper_sync
from vibez.beeper_sync import get_whatsapp_groups, parse_beeper_message
from vibez.db import get_connection, init_db


def test_load_excluded_groups_uses_defaults_when_env_missing(monkeypatch):
    monkeypatch.delenv("VIBEZ_EXCLUDED_GROUPS", raising=False)
    excluded = beeper_sync.load_excluded_groups()
    assert "BBC News" in excluded
    assert "Bloomberg News" in excluded


def test_load_excluded_groups_reads_env_override(monkeypatch):
    monkeypatch.setenv("VIBEZ_EXCLUDED_GROUPS", "BBC News,Custom Chatter,  Plum  ,")
    excluded = beeper_sync.load_excluded_groups()
    assert excluded == {"BBC News", "Custom Chatter", "Plum"}


def test_load_allowed_groups_uses_empty_set_when_env_missing(monkeypatch):
    monkeypatch.delenv("VIBEZ_ALLOWED_GROUPS", raising=False)
    allowed = beeper_sync.load_allowed_groups()
    assert allowed == set()


def test_load_allowed_groups_reads_env_values(monkeypatch):
    monkeypatch.setenv(
        "VIBEZ_ALLOWED_GROUPS",
        "Show and Tell, The vibez (code code code),  audio intelligence  ,",
    )
    allowed = beeper_sync.load_allowed_groups()
    assert allowed == {
        "Show and Tell",
        "The vibez (code code code)",
        "audio intelligence",
    }


def test_get_whatsapp_groups_refuses_empty_allowlist(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "network": "WhatsApp", "type": "group", "title": "Personal group"},
        ]
    }
    monkeypatch.delenv("VIBEZ_ALLOWED_GROUPS", raising=False)
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token")

    assert groups == []


def test_get_whatsapp_groups_filters_to_whatsapp_groups(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "network": "WhatsApp", "type": "group", "title": "The vibez"},
            {"id": "d1", "network": "WhatsApp", "type": "dm", "title": "Direct thread"},
            {"id": "s1", "network": "Signal", "type": "group", "title": "Signal group"},
        ]
    }
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token", allowed_groups={"The vibez"})

    assert [g["id"] for g in groups] == ["g1"]


def test_get_whatsapp_groups_limits_desktop_api_to_whatsapp_account(monkeypatch):
    seen: list[tuple[str, dict | None]] = []

    def fake_api_get(_base_url, path, _token, params=None):
        seen.append((path, params))
        return {"items": []}

    monkeypatch.setattr(beeper_sync, "api_get", fake_api_get)

    get_whatsapp_groups("http://localhost:23373", "token", allowed_groups={"The vibez"})

    assert seen == [("/v1/chats", {"limit": "200", "accountIDs": "whatsapp"})]


def test_get_whatsapp_groups_accepts_account_id_when_network_missing(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "accountID": "whatsapp", "type": "group", "title": "The vibez"},
            {"id": "g2", "accountID": "whatsapp", "type": "dm", "title": "Direct thread"},
            {"id": "g3", "accountID": "slackgo.T123", "type": "group", "title": "General"},
        ]
    }
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token", allowed_groups={"The vibez"})

    assert [g["id"] for g in groups] == ["g1"]


def test_get_whatsapp_groups_excludes_known_non_community_groups(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "network": "WhatsApp", "type": "group", "title": "The vibez"},
            {"id": "g2", "network": "WhatsApp", "type": "group", "title": "BBC News"},
            {"id": "g3", "network": "WhatsApp", "type": "group", "title": "Bloomberg News"},
        ]
    }
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token", allowed_groups={"The vibez"})

    assert [g["title"] for g in groups] == ["The vibez"]


def test_get_whatsapp_groups_respects_allowlist(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "network": "WhatsApp", "type": "group", "title": "The vibez (code code code)"},
            {"id": "g2", "network": "WhatsApp", "type": "group", "title": "Off-topic"},
            {"id": "g3", "network": "WhatsApp", "type": "group", "title": "Show and Tell"},
        ]
    }
    monkeypatch.setenv(
        "VIBEZ_ALLOWED_GROUPS",
        "Show and Tell,The vibez (code code code)",
    )
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token")

    assert [g["title"] for g in groups] == [
        "The vibez (code code code)",
        "Show and Tell",
    ]


def test_get_whatsapp_groups_allowlist_matching_is_case_insensitive(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "network": "WhatsApp", "type": "group", "title": "Security"},
            {"id": "g2", "network": "WhatsApp", "type": "group", "title": "audio intelligence"},
            {"id": "g3", "network": "WhatsApp", "type": "group", "title": "TechRadar"},
        ]
    }
    monkeypatch.setenv(
        "VIBEZ_ALLOWED_GROUPS",
        "security,AUDIO INTELLIGENCE",
    )
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token")

    assert [g["title"] for g in groups] == [
        "Security",
        "audio intelligence",
    ]


def test_backfill_group_discovery_respects_allowlist(monkeypatch):
    from scripts import beeper_api_backfill

    seen: list[tuple[str, dict | None]] = []

    def fake_api_get(path, _token, params=None):
        seen.append((path, params))
        return {
            "items": [
                {"id": "g1", "accountID": "whatsapp", "type": "group", "title": "Show and Tell"},
                {"id": "g2", "accountID": "whatsapp", "type": "group", "title": "Personal group"},
                {"id": "d1", "accountID": "whatsapp", "type": "dm", "title": "Direct thread"},
            ]
        }

    monkeypatch.setattr(beeper_api_backfill, "api_get", fake_api_get)

    groups = beeper_api_backfill.get_whatsapp_groups("token", allowed_groups={"Show and Tell"})

    assert seen == [("/v1/chats", {"limit": "200", "accountIDs": "whatsapp"})]
    assert [group["title"] for group in groups] == ["Show and Tell"]


def test_backfill_group_discovery_refuses_empty_allowlist(monkeypatch):
    from scripts import beeper_api_backfill

    monkeypatch.setattr(
        beeper_api_backfill,
        "api_get",
        lambda *_args, **_kwargs: {"items": [{"id": "g1", "accountID": "whatsapp", "type": "group"}]},
    )

    assert beeper_api_backfill.get_whatsapp_groups("token", allowed_groups=set()) == []


def test_sync_loop_passes_explicit_allowed_groups(monkeypatch, tmp_path):
    seen = {}

    def fake_get_whatsapp_groups(_base_url, _token, **kwargs):
        seen["allowed_groups"] = kwargs.get("allowed_groups")
        return []

    monkeypatch.setattr(beeper_sync, "init_db", lambda _db_path: None)
    monkeypatch.setattr(beeper_sync, "check_token_health", lambda _base_url, _token: None)
    monkeypatch.setattr(beeper_sync, "get_whatsapp_groups", fake_get_whatsapp_groups)
    monkeypatch.setattr(beeper_sync, "save_active_groups", lambda _db_path, _groups: None)
    monkeypatch.setattr(beeper_sync, "poll_once", lambda *_args, **_kwargs: (_ for _ in ()).throw(asyncio.CancelledError()))

    allowed = {"Show and Tell", "Security"}
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(beeper_sync.sync_loop(
            tmp_path / "vibez.db",
            "http://localhost:23373",
            "token",
            allowed_groups=allowed,
        ))

    assert seen["allowed_groups"] == allowed


def test_parse_text_message():
    msg = {
        "id": "12345",
        "chatID": "!room:beeper.local",
        "senderID": "@whatsapp_lid-123:beeper.local",
        "senderName": "Harper",
        "timestamp": "2026-02-18T20:00:00.000Z",
        "sortKey": "12345",
        "type": "TEXT",
        "text": "check out this repo",
    }
    result = parse_beeper_message(msg, "The vibez")
    assert result is not None
    assert result["id"] == "beeper-!room:beeper.local-12345"
    assert result["sender_name"] == "Harper"
    assert result["body"] == "check out this repo"
    assert result["room_name"] == "The vibez"
    assert result["timestamp"] == 1771444800000


def test_parse_image_with_caption():
    msg = {
        "id": "999",
        "chatID": "!room:beeper.local",
        "senderID": "@u:b",
        "senderName": "MG",
        "timestamp": "2026-02-18T15:00:00.000Z",
        "sortKey": "999",
        "type": "IMAGE",
        "text": "screenshot of my setup",
    }
    result = parse_beeper_message(msg, "Show and Tell")
    assert result is not None
    assert result["body"] == "screenshot of my setup"


def test_parse_skips_reaction():
    msg = {
        "id": "555",
        "chatID": "!room:beeper.local",
        "senderID": "@u:b",
        "senderName": "Bray",
        "timestamp": "2026-02-18T10:00:00.000Z",
        "sortKey": "555",
        "type": "REACTION",
    }
    result = parse_beeper_message(msg, "Test")
    assert result is None


def test_parse_skips_empty_text():
    msg = {
        "id": "666",
        "chatID": "!room:beeper.local",
        "senderID": "@u:b",
        "senderName": "Someone",
        "timestamp": "2026-02-18T10:00:00.000Z",
        "sortKey": "666",
        "type": "TEXT",
        "text": "",
    }
    result = parse_beeper_message(msg, "Test")
    assert result is None


def test_parse_skips_encrypted_placeholder():
    msg = {
        "id": "667",
        "chatID": "!room:beeper.local",
        "senderID": "@u:b",
        "senderName": "Someone",
        "timestamp": "2026-02-18T10:00:00.000Z",
        "sortKey": "667",
        "type": "TEXT",
        "text": "  Encrypted  ",
    }
    result = parse_beeper_message(msg, "Test")
    assert result is None


def test_parse_cleans_matrix_sender_name():
    msg = {
        "id": "777",
        "chatID": "!room:beeper.local",
        "senderID": "@dbmcco:beeper.com",
        "senderName": "@dbmcco:beeper.com",
        "timestamp": "2026-02-18T10:00:00.000Z",
        "sortKey": "777",
        "type": "TEXT",
        "text": "hello",
    }
    result = parse_beeper_message(msg, "Test")
    assert result is not None
    assert result["sender_name"] == "dbmcco"


def test_poll_once_returns_only_inserted_messages_for_classification(monkeypatch):
    raw_duplicate = {
        "id": "old",
        "chatID": "chat-1",
        "senderID": "@u:b",
        "senderName": "Dana",
        "timestamp": "2026-05-18T10:00:00.000Z",
        "sortKey": "old-sk",
        "type": "TEXT",
        "text": "already seen",
    }
    raw_new = {
        "id": "new",
        "chatID": "chat-1",
        "senderID": "@u:b",
        "senderName": "Lee",
        "timestamp": "2026-05-18T10:05:00.000Z",
        "sortKey": "new-sk",
        "type": "TEXT",
        "text": "fresh message",
    }
    saved_cursors: list[tuple[str, str]] = []

    monkeypatch.setattr(beeper_sync, "load_cursor", lambda *_args: "old-sk")
    monkeypatch.setattr(
        beeper_sync,
        "fetch_new_messages",
        lambda *_args: ([raw_duplicate, raw_new], "new-sk"),
    )

    def fake_save_messages(_db_path, messages):
        return [message for message in messages if message["id"].endswith("-new")]

    monkeypatch.setattr(beeper_sync, "save_messages", fake_save_messages)
    monkeypatch.setattr(
        beeper_sync,
        "save_cursor",
        lambda _db_path, chat_id, cursor: saved_cursors.append((chat_id, cursor)),
    )
    monkeypatch.setattr(beeper_sync, "publish_event", lambda *_args, **_kwargs: None)

    messages = beeper_sync.poll_once(
        None,
        "http://localhost:23373",
        "token",
        [{"id": "chat-1", "title": "Agents"}],
    )

    assert [message["body"] for message in messages] == ["fresh message"]
    assert saved_cursors == [("chat-1", "new-sk")]


def test_save_active_groups_persists_ids_and_names(tmp_path):
    db_path = tmp_path / "vibez.db"
    init_db(db_path)
    groups = [
        {"id": "!a:beeper.local", "title": "The vibez"},
        {"id": "!b:beeper.local", "title": "Off-topic"},
    ]

    beeper_sync.save_active_groups(db_path, groups)

    conn = get_connection(db_path)
    rows = dict(conn.execute("SELECT key, value FROM sync_state").fetchall())
    conn.close()

    assert rows["beeper_active_group_ids"] == '["!a:beeper.local", "!b:beeper.local"]'
    assert rows["beeper_active_group_names"] == '["The vibez", "Off-topic"]'


def test_api_get_closes_http_response(monkeypatch):
    class FakeResponse:
        def __init__(self):
            self.closed = False

        def read(self):
            return b'{"items":[]}'

        def close(self):
            self.closed = True

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self.close()
            return False

    response = FakeResponse()
    monkeypatch.setattr(beeper_sync.urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    result = beeper_sync.api_get("http://localhost:23373", "/v1/chats", "token")

    assert result == {"items": []}
    assert response.closed is True
