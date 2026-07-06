from vibez.matrix_sync import (
    parse_message_event,
    filter_whatsapp_rooms,
    extract_messages_from_sync,
)


def test_parse_message_event():
    event = {
        "event_id": "$abc123",
        "sender": "@whatsapp_1234:beeper.local",
        "type": "m.room.message",
        "origin_server_ts": 1708300000000,
        "content": {"msgtype": "m.text", "body": "check out this repo https://github.com/foo/bar"},
    }
    msg = parse_message_event(event, "!room1:beeper.local", "The vibez")
    assert msg["id"] == "$abc123"
    assert msg["body"] == "check out this repo https://github.com/foo/bar"
    assert msg["room_name"] == "The vibez"
    assert msg["timestamp"] == 1708300000000


def test_parse_message_event_skips_non_message():
    event = {"event_id": "$abc", "sender": "@u:b", "type": "m.room.member",
             "origin_server_ts": 1000, "content": {"membership": "join"}}
    msg = parse_message_event(event, "!r:b", "room")
    assert msg is None


def test_parse_message_event_extracts_beeper_sender_name():
    event = {
        "event_id": "$ev1", "sender": "@whatsapp_1234:beeper.local",
        "type": "m.room.message", "origin_server_ts": 1000,
        "content": {"msgtype": "m.text", "body": "hello", "com.beeper.sender_name": "Harper"},
    }
    msg = parse_message_event(event, "!r:b", "room")
    assert msg["sender_name"] == "Harper"


def test_parse_mautrix_message_uses_source_prefix_and_mxid_sender():
    event = {
        "event_id": "$ev1",
        "sender": "@whatsapp_15551234567:matrix.vibez",
        "type": "m.room.message",
        "origin_server_ts": 1770000000000,
        "content": {"msgtype": "m.text", "body": "hello"},
    }
    msg = parse_message_event(
        event,
        "!wa:matrix.vibez",
        "AGI Builders",
        source_name="mautrix",
    )
    assert msg["id"] == "matrix:mautrix:$ev1"
    assert msg["sender_name"] == "+15551234567"


def test_parse_message_event_prefers_displayname_for_mautrix_sender():
    event = {
        "event_id": "$ev2",
        "sender": "@whatsapp_15551234567:matrix.vibez",
        "type": "m.room.message",
        "origin_server_ts": 1770000001000,
        "content": {
            "msgtype": "m.text",
            "body": "hello",
            "com.mautrix.displayname": "Riley",
        },
    }
    msg = parse_message_event(
        event,
        "!wa:matrix.vibez",
        "AGI Builders",
        source_name="mautrix",
    )
    assert msg["sender_name"] == "Riley"


def test_filter_whatsapp_rooms():
    rooms_state = {
        "!wa_room:beeper.local": {
            "state": {"events": [
                {"type": "m.bridge", "content": {"com.beeper.bridge_name": "whatsapp"}},
                {"type": "m.room.name", "content": {"name": "The vibez (code code code)"}},
            ]}
        },
        "!slack_room:beeper.local": {
            "state": {"events": [
                {"type": "m.bridge", "content": {"com.beeper.bridge_name": "slackgo"}},
            ]}
        },
    }
    wa_rooms = filter_whatsapp_rooms(rooms_state)
    assert "!wa_room:beeper.local" in wa_rooms
    assert "!slack_room:beeper.local" not in wa_rooms
    assert wa_rooms["!wa_room:beeper.local"] == "The vibez (code code code)"


def test_filter_whatsapp_rooms_detects_mautrix_bridge_info():
    rooms_state = {
        "!wa_room:matrix.vibez": {
            "state": {"events": [
                {
                    "type": "m.bridge",
                    "content": {
                        "bridgebot": "@whatsappbot:matrix.vibez",
                        "protocol": {"id": "whatsapp"},
                    },
                },
                {"type": "m.room.name", "content": {"name": "AGI Builders"}},
            ]}
        },
        "!general:matrix.vibez": {
            "state": {"events": [
                {"type": "m.room.name", "content": {"name": "General"}},
            ]}
        },
    }
    assert filter_whatsapp_rooms(rooms_state) == {
        "!wa_room:matrix.vibez": "AGI Builders"
    }


def test_extract_messages_from_sync():
    known_rooms = {"!r1:b": "The vibez"}
    sync_response = {
        "rooms": {"join": {
            "!r1:b": {"timeline": {"events": [
                {"event_id": "$e1", "sender": "@u:b", "type": "m.room.message",
                 "origin_server_ts": 1000, "content": {"msgtype": "m.text", "body": "hello"}},
                {"event_id": "$e2", "sender": "@u:b", "type": "m.room.member",
                 "origin_server_ts": 1001, "content": {"membership": "join"}},
            ]}},
            "!unknown:b": {"timeline": {"events": [
                {"event_id": "$e3", "sender": "@u:b", "type": "m.room.message",
                 "origin_server_ts": 1002, "content": {"msgtype": "m.text", "body": "ignored"}},
            ]}},
        }}
    }
    messages = extract_messages_from_sync(sync_response, known_rooms)
    assert len(messages) == 1
    assert messages[0]["id"] == "$e1"
