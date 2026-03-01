from email.message import EmailMessage

from vibez.db import get_connection, init_db
from vibez import google_groups_sync
from vibez.google_groups_sync import canonical_group_key, parse_group_email, poll_once


def test_canonical_group_key_accepts_list_id_and_address_forms():
    assert canonical_group_key("Made of Meat <made-of-meat.googlegroups.com>") == "made-of-meat"
    assert canonical_group_key("made-of-meat@googlegroups.com") == "made-of-meat"


def test_parse_group_email_maps_message_into_vibez_row():
    msg = EmailMessage()
    msg["From"] = "Braydon McCormick <b@mcco.us>"
    msg["To"] = "made-of-meat@googlegroups.com"
    msg["List-Id"] = "Made of Meat <made-of-meat.googlegroups.com>"
    msg["Subject"] = "Thread kickoff"
    msg["Date"] = "Thu, 27 Feb 2026 10:00:00 +0000"
    msg["Message-ID"] = "<abc123@example.com>"
    msg.set_content("New thought here.\n\nOn Wed someone wrote:\n> quoted text")

    row = parse_group_email(
        msg.as_bytes(),
        uid=10,
        allowed_groups={"made-of-meat"},
    )

    assert row is not None
    assert row["room_id"] == "googlegroup:made-of-meat"
    assert row["room_name"] == "made-of-meat"
    assert row["sender_name"] == "Braydon McCormick"
    assert row["sender_id"] == "b@mcco.us"
    assert row["body"] == "New thought here."
    assert row["timestamp"] == 1772186400000


def test_parse_group_email_respects_allowed_group_filter():
    msg = EmailMessage()
    msg["From"] = "Example User <user@example.com>"
    msg["To"] = "made-of-meat@googlegroups.com"
    msg["Date"] = "Thu, 27 Feb 2026 10:00:00 +0000"
    msg["Message-ID"] = "<abc123@example.com>"
    msg.set_content("hello")

    row = parse_group_email(
        msg.as_bytes(),
        uid=11,
        allowed_groups={"some-other-group"},
    )
    assert row is None


def test_poll_once_uses_uid_search_with_explicit_uid_criterion(tmp_db, monkeypatch):
    init_db(tmp_db)
    conn = get_connection(tmp_db)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        ("google_groups_uid_cursor:INBOX", "42"),
    )
    conn.commit()
    conn.close()

    seen: dict[str, list[tuple[str, tuple[object, ...]]]] = {"uid_calls": []}

    class FakeIMAP:
        def __init__(self, host, port):
            self.host = host
            self.port = port

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def login(self, user, password):
            return "OK", []

        def select(self, mailbox, readonly=True):
            return "OK", []

        def uid(self, command, *args):
            seen["uid_calls"].append((command, args))
            if command == "SEARCH":
                return "OK", [b""]
            return "OK", []

    monkeypatch.setattr(google_groups_sync.imaplib, "IMAP4_SSL", FakeIMAP)

    rows = poll_once(
        db_path=tmp_db,
        host="imap.gmail.com",
        port=993,
        user="b@mcco.us",
        password="app-pass",
        mailbox="INBOX",
        group_keys={"made-of-meat"},
    )

    assert rows == []
    assert seen["uid_calls"] == [("SEARCH", (None, "UID", "43:*"))]
