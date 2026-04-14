from vibez.db import get_connection, init_db
from vibez.links import get_links, refresh_message_links


def _insert_message(
    conn,
    *,
    event_id: str,
    room_name: str,
    body: str,
    timestamp: int,
    sender_name: str = "Alice",
) -> None:
    conn.execute(
        """INSERT INTO messages
           (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            event_id,
            room_name.lower().replace(" ", "-"),
            room_name,
            sender_name.lower(),
            sender_name,
            body,
            timestamp,
            "{}",
        ),
    )


def test_refresh_message_links_increments_from_watermark(tmp_path):
    db_path = tmp_path / "vibez.db"
    init_db(db_path)
    conn = get_connection(db_path)
    _insert_message(
        conn,
        event_id="m1",
        room_name="Show and Tell",
        body="check this https://example.com/a",
        timestamp=1_000,
    )
    _insert_message(
        conn,
        event_id="m2",
        room_name="Show and Tell",
        body="another one https://example.com/b",
        timestamp=2_000,
    )
    conn.commit()
    conn.close()

    result = refresh_message_links(db_path)

    assert result["messages_scanned"] == 2
    assert result["links_inserted"] == 2
    assert result["latest_timestamp"] == 2_000
    links = get_links(db_path, limit=10)
    assert {link["url"] for link in links} == {
        "https://example.com/a",
        "https://example.com/b",
    }

    conn = get_connection(db_path)
    watermark = conn.execute(
        "SELECT value FROM sync_state WHERE key = 'links_last_refresh_ts'"
    ).fetchone()
    conn.close()
    assert watermark == ("2000",)

    conn = get_connection(db_path)
    _insert_message(
        conn,
        event_id="m3",
        room_name="Show and Tell",
        body="repeat https://example.com/b and new https://example.com/c",
        timestamp=3_000,
    )
    conn.commit()
    conn.close()

    second = refresh_message_links(db_path)

    assert second["messages_scanned"] == 1
    assert second["links_inserted"] == 1
    assert second["latest_timestamp"] == 3_000
    links = get_links(db_path, limit=10)
    by_url = {link["url"]: link for link in links}
    assert set(by_url) == {
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
    }
    assert by_url["https://example.com/b"]["mention_count"] == 2


def test_refresh_message_links_respects_allowlist_on_full_rebuild(tmp_path):
    db_path = tmp_path / "vibez.db"
    init_db(db_path)
    conn = get_connection(db_path)
    _insert_message(
        conn,
        event_id="m1",
        room_name="Show and Tell",
        body="allowed https://example.com/allowed",
        timestamp=1_000,
    )
    _insert_message(
        conn,
        event_id="m2",
        room_name="Off-topic",
        body="blocked https://example.com/blocked",
        timestamp=2_000,
    )
    conn.execute(
        """INSERT INTO links
           (url, url_hash, title, category, relevance, shared_by, source_group, first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "https://example.com/stale",
            "stale-hash",
            "Stale",
            "repo",
            "",
            "Alice",
            "TechRadar",
            "2026-01-01T00:00:00",
            "2026-01-01T00:00:00",
            1,
            1.0,
            "",
            "Alice",
            1,
        ),
    )
    conn.commit()
    conn.close()

    result = refresh_message_links(
        db_path,
        allowed_groups={"Show and Tell"},
        full_rebuild=True,
    )

    assert result["messages_scanned"] == 1
    assert result["links_inserted"] == 1
    links = get_links(db_path, limit=10)
    assert [link["url"] for link in links] == ["https://example.com/allowed"]

    conn = get_connection(db_path)
    watermark = conn.execute(
        "SELECT value FROM sync_state WHERE key = 'links_last_refresh_ts'"
    ).fetchone()
    conn.close()
    assert watermark == ("1000",)
