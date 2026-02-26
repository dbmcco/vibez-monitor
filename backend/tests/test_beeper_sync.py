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


def test_get_whatsapp_groups_filters_to_whatsapp_groups(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "network": "WhatsApp", "type": "group", "title": "The vibez"},
            {"id": "d1", "network": "WhatsApp", "type": "dm", "title": "Direct thread"},
            {"id": "s1", "network": "Signal", "type": "group", "title": "Signal group"},
        ]
    }
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token")

    assert [g["id"] for g in groups] == ["g1"]


def test_get_whatsapp_groups_accepts_account_id_when_network_missing(monkeypatch):
    payload = {
        "items": [
            {"id": "g1", "accountID": "whatsapp", "type": "group", "title": "The vibez"},
            {"id": "g2", "accountID": "whatsapp", "type": "dm", "title": "Direct thread"},
            {"id": "g3", "accountID": "slackgo.T123", "type": "group", "title": "General"},
        ]
    }
    monkeypatch.setattr(beeper_sync, "api_get", lambda *_args, **_kwargs: payload)

    groups = get_whatsapp_groups("http://localhost:23373", "token")

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

    groups = get_whatsapp_groups("http://localhost:23373", "token")

    assert [g["title"] for g in groups] == ["The vibez"]


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
