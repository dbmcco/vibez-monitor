# ABOUTME: Backfill script that extracts URLs directly from chat messages into the links table.
# ABOUTME: Catches links the synthesis pipeline missed — runs over all historical messages.

"""Scan all messages for URLs and upsert them into the links table."""

import sys
from pathlib import Path

# Allow running from repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.db import get_connection
from vibez.links import upsert_message_links


def enrich_link_context(db_path: Path) -> int:
    """Two-pass enrichment for link relevance fields.

    Pass 1: For each link, grab nearby messages (2h window) from the same
    sender in the same room where the URL appeared.

    Pass 2: For each sender, find the topics they discuss most in non-URL
    messages (project names, tools, etc.) and attach that context to all
    their links. This catches cases like Dan talking about 'trycycle'
    across many conversations while his blog post URL is in a separate message.
    """
    from vibez.links import _sync_fts_row

    conn = get_connection(db_path)
    links = conn.execute(
        "SELECT id, url, url_hash, shared_by, relevance FROM links WHERE shared_by != ''"
    ).fetchall()
    enriched = 0

    # Pass 1: Nearby message context
    for link_id, url, url_hash, shared_by, relevance in links:
        senders = [s.strip() for s in shared_by.split(",")]
        for sender in senders:
            if not sender:
                continue
            msg_row = conn.execute(
                "SELECT timestamp, room_name FROM messages "
                "WHERE sender_name = ? AND body LIKE ? ORDER BY timestamp DESC LIMIT 1",
                (sender, f"%{url[:60]}%"),
            ).fetchone()
            if not msg_row:
                continue
            ts, room = msg_row
            window_ms = 2 * 60 * 60 * 1000
            nearby = conn.execute(
                "SELECT body FROM messages "
                "WHERE sender_name = ? AND room_name = ? "
                "AND timestamp BETWEEN ? AND ? "
                "AND body NOT LIKE '%http%' "
                "ORDER BY timestamp ASC LIMIT 8",
                (sender, room, ts - window_ms, ts + window_ms),
            ).fetchall()
            if not nearby:
                continue
            extra = " | ".join(row[0][:200] for row in nearby)
            if extra and extra not in (relevance or ""):
                new_relevance = f"{relevance} | {extra}" if relevance else extra
                new_relevance = new_relevance[:1000]
                conn.execute(
                    "UPDATE links SET relevance = ? WHERE id = ?",
                    (new_relevance, link_id),
                )
                _sync_fts_row(conn, url_hash)
                enriched += 1
    conn.commit()

    # Pass 2: Sender topic fingerprints
    # For each sender who shared links, build a short "topic string"
    # from their most distinctive non-URL messages and append to all their links
    senders = set()
    for _, _, _, shared_by, _ in links:
        for s in shared_by.split(","):
            s = s.strip()
            if s:
                senders.add(s)

    topic_enriched = 0
    for sender in senders:
        # Get non-URL messages that mention project/tool names
        msgs = conn.execute(
            "SELECT body FROM messages WHERE sender_name = ? AND body NOT LIKE '%http%' "
            "ORDER BY timestamp DESC LIMIT 200",
            (sender,),
        ).fetchall()
        if not msgs:
            continue
        # Build a condensed topic string from their messages
        all_text = " ".join(row[0][:100] for row in msgs)
        # Truncate to a reasonable topic fingerprint
        topic_fingerprint = f"[{sender} topics: {all_text[:400]}]"

        # Update all links from this sender that don't already have this fingerprint
        sender_links = conn.execute(
            "SELECT id, url_hash, relevance FROM links WHERE shared_by LIKE ?",
            (f"%{sender}%",),
        ).fetchall()
        for lid, lhash, lrel in sender_links:
            if topic_fingerprint[:50] in (lrel or ""):
                continue
            new_rel = f"{lrel} {topic_fingerprint}" if lrel else topic_fingerprint
            new_rel = new_rel[:1500]
            conn.execute("UPDATE links SET relevance = ? WHERE id = ?", (new_rel, lid))
            _sync_fts_row(conn, lhash)
            topic_enriched += 1

    conn.commit()
    conn.close()
    return enriched + topic_enriched


def main(db_path_str: str) -> None:
    db_path = Path(db_path_str)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        sys.exit(1)

    conn = get_connection(db_path)

    # Count before
    before = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]

    # Fetch all messages with bodies containing URLs
    rows = conn.execute(
        "SELECT id, body, sender_name, timestamp, room_name FROM messages "
        "WHERE body LIKE '%http%' ORDER BY timestamp ASC"
    ).fetchall()
    conn.close()

    print(f"Found {len(rows)} messages with URLs")
    print(f"Links before: {before}")

    messages = [
        {
            "id": r[0],
            "body": r[1],
            "sender_name": r[2],
            "timestamp": r[3],
            "room_name": r[4],
        }
        for r in rows
    ]

    # Process in batches of 500 to avoid huge dicts
    batch_size = 500
    total_inserted = 0
    for i in range(0, len(messages), batch_size):
        batch = messages[i : i + batch_size]
        inserted = upsert_message_links(db_path, batch)
        total_inserted += inserted
        if inserted:
            print(f"  Batch {i // batch_size + 1}: +{inserted} new links")

    conn = get_connection(db_path)
    after = conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    conn.close()

    print(f"\nLinks before: {before}, after: {after}, new: {total_inserted}")

    # Phase 2: Enrich with nearby message context
    print("\nEnriching links with nearby sender context...")
    enriched = enrich_link_context(db_path)
    print(f"Enriched {enriched} links with surrounding context")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: python {sys.argv[0]} <path-to-vibez.db>")
        sys.exit(1)
    main(sys.argv[1])
