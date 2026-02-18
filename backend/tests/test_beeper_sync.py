from vibez.beeper_sync import parse_beeper_message


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
