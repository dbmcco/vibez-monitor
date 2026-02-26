"""Backfill messages from Beeper Desktop API into vibez.db.

Pulls decrypted WhatsApp messages from the Beeper Desktop API (localhost:23373)
for the date range missing from the WhatsApp export (Jan 29 -> now).

Usage:
    python scripts/beeper_api_backfill.py [--token TOKEN] [--since 2025-01-29] [--dry-run]
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vibez.db import get_connection, init_db

API_BASE = "http://localhost:23373"
PAGE_SIZE = 100  # max messages per request


def api_get(path: str, token: str, params: dict | None = None) -> dict:
    """Make authenticated GET request to Beeper Desktop API."""
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())


def get_whatsapp_groups(token: str) -> list[dict]:
    """List all WhatsApp group chats."""
    def is_whatsapp_group(chat: dict) -> bool:
        network = str(chat.get("network", "")).strip().casefold()
        account_id = str(chat.get("accountID", "")).strip().casefold()
        return (
            chat.get("type") == "group"
            and (
                network == "whatsapp"
                or account_id == "whatsapp"
                or account_id.startswith("whatsapp")
            )
        )

    data = api_get("/v1/chats", token, {"limit": "200"})
    return [
        c for c in data["items"]
        if is_whatsapp_group(c)
    ]


def fetch_messages_since(token: str, chat_id: str, since_ts: float) -> list[dict]:
    """Fetch all messages from a chat newer than since_ts (epoch seconds)."""
    encoded = urllib.parse.quote(chat_id, safe="")
    all_msgs = []
    cursor = None
    page = 0

    while True:
        params = {}
        if cursor:
            params["cursor"] = str(cursor)
            params["direction"] = "before"

        data = api_get(f"/v1/chats/{encoded}/messages", token, params)
        items = data.get("items", [])
        if not items:
            break

        reached_cutoff = False
        for msg in items:
            msg_ts = datetime.fromisoformat(msg["timestamp"].replace("Z", "+00:00")).timestamp()
            if msg_ts < since_ts:
                reached_cutoff = True
                break
            all_msgs.append(msg)

        if reached_cutoff:
            break

        page += 1
        cursor = items[-1]["sortKey"]

        if not data.get("hasMore", False):
            break

    return all_msgs


def msg_to_row(msg: dict, room_name: str) -> dict | None:
    """Convert Beeper API message to vibez.db row format."""
    if msg.get("type") not in ("TEXT", "IMAGE", "VIDEO", "AUDIO", "FILE"):
        return None  # skip reactions, system messages, etc.

    text = msg.get("text", "") or ""
    if not text.strip():
        return None

    ts_str = msg["timestamp"].replace("Z", "+00:00")
    ts_ms = int(datetime.fromisoformat(ts_str).timestamp() * 1000)

    sender_name = msg.get("senderName", "")
    # Clean up Matrix-style sender IDs used as names
    if sender_name.startswith("@") and ":" in sender_name:
        sender_name = sender_name.split(":")[0].lstrip("@")

    return {
        "id": f"beeper-{msg['chatID']}-{msg['id']}",
        "room_id": msg["chatID"],
        "room_name": room_name,
        "sender_id": msg.get("senderID", ""),
        "sender_name": sender_name,
        "body": text,
        "timestamp": ts_ms,
        "raw_event": json.dumps(msg),
    }


def import_messages(db_path: Path, rows: list[dict], dry_run: bool = False) -> int:
    """Insert messages into vibez.db, skipping duplicates."""
    if dry_run:
        return len(rows)

    conn = get_connection(db_path)
    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR IGNORE INTO messages
                   (id, room_id, room_name, sender_id, sender_name, body, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (row["id"], row["room_id"], row["room_name"],
                 row["sender_id"], row["sender_name"], row["body"], row["timestamp"]),
            )
            inserted += conn.total_changes  # rough — counts all changes
        except sqlite3.IntegrityError:
            pass
    conn.commit()
    actual = conn.execute(
        "SELECT changes()"
    ).fetchone()
    conn.close()
    return inserted


def main():
    parser = argparse.ArgumentParser(description="Backfill from Beeper Desktop API")
    parser.add_argument("--token", required=True, help="Beeper Desktop API bearer token")
    parser.add_argument("--since", default="2025-01-29", help="Start date (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to DB")
    parser.add_argument("--db", default=None, help="Path to vibez.db")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else Path(__file__).resolve().parent.parent.parent / "vibez.db"
    since_ts = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()

    if not args.dry_run:
        init_db(db_path)

    print(f"Fetching WhatsApp messages since {args.since} from Beeper Desktop API...")
    groups = get_whatsapp_groups(args.token)
    print(f"Found {len(groups)} WhatsApp groups")

    total_fetched = 0
    total_imported = 0

    for group in groups:
        chat_id = group["id"]
        title = group["title"]
        print(f"\n  {title}...")

        messages = fetch_messages_since(args.token, chat_id, since_ts)
        rows = [r for m in messages if (r := msg_to_row(m, title)) is not None]
        print(f"    {len(messages)} API messages -> {len(rows)} text rows")
        total_fetched += len(messages)

        if rows and not args.dry_run:
            conn = get_connection(db_path)
            before_count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            for row in rows:
                conn.execute(
                    """INSERT OR IGNORE INTO messages
                       (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (row["id"], row["room_id"], row["room_name"],
                     row["sender_id"], row["sender_name"], row["body"], row["timestamp"],
                     row["raw_event"]),
                )
            conn.commit()
            after_count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            conn.close()
            new = after_count - before_count
            total_imported += new
            print(f"    -> {new} new messages imported")
        elif rows:
            total_imported += len(rows)
            print(f"    -> {len(rows)} would be imported (dry-run)")

    print(f"\nDone: {total_fetched} fetched, {total_imported} imported across {len(groups)} groups")


if __name__ == "__main__":
    main()
