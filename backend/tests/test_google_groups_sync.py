from email.message import EmailMessage

from vibez.google_groups_sync import canonical_group_key, parse_group_email


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
