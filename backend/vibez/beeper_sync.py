"""Beeper Desktop API sync service — polls for new WhatsApp messages.

Replaces the Matrix sync approach (which can't decrypt E2EE messages)
with the Beeper Desktop API (localhost:23373) which provides decrypted
message content directly.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from vibez.db import get_connection, init_db
from vibez.paia_events_adapter import publish_event

logger = logging.getLogger("vibez.sync")

DEFAULT_API_BASE = "http://localhost:23373"
POLL_INTERVAL = 30  # seconds between polls
TOKEN_WARN_DAYS = 3  # warn when token expires within this many days

# Default groups to exclude from monitoring (not part of the AGI community)
DEFAULT_EXCLUDED_GROUPS = {
    "BBC News",
    "Bloomberg News",
    "MTB Rides",
    "Plum",
}


def parse_excluded_groups(raw: str | None) -> set[str]:
    """Parse excluded group names from a comma-separated env var."""
    if raw is None:
        return set(DEFAULT_EXCLUDED_GROUPS)
    return {name.strip() for name in raw.split(",") if name.strip()}


def load_excluded_groups() -> set[str]:
    """Load excluded group names from env, falling back to defaults."""
    return parse_excluded_groups(os.environ.get("VIBEZ_EXCLUDED_GROUPS"))


def check_token_health(base_url: str, token: str) -> None:
    """Check token validity and warn if near expiry."""
    try:
        data = urllib.request.urlopen(
            urllib.request.Request(
                f"{base_url}/oauth/introspect",
                data=urllib.parse.urlencode({
                    "token": token, "token_type_hint": "access_token",
                }).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            ),
            timeout=10,
        )
        info = json.loads(data.read())
        if not info.get("active"):
            logger.error("Beeper API token is INACTIVE. Sync will fail.")
            return
        exp = info.get("exp")
        if exp:
            remaining = exp - time.time()
            days_left = remaining / 86400
            if days_left < TOKEN_WARN_DAYS:
                logger.warning("Beeper API token expires in %.1f days! Re-auth soon.", days_left)
            else:
                logger.info("Token valid, expires in %.0f days", days_left)
        else:
            logger.info("Token valid (no expiry set)")
    except Exception:
        logger.warning("Could not check token health (non-fatal)")


def api_get(base_url: str, path: str, token: str, params: dict | None = None) -> dict:
    """Make authenticated GET to the Beeper Desktop API."""
    url = f"{base_url}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())


def get_whatsapp_groups(
    base_url: str, token: str, excluded_groups: set[str] | None = None,
) -> list[dict]:
    """List WhatsApp group chats from Beeper, excluding non-community groups."""
    if excluded_groups is None:
        excluded_groups = load_excluded_groups()
    data = api_get(base_url, "/v1/chats", token, {"limit": "200"})
    return [
        c for c in data.get("items", [])
        if c.get("network") == "WhatsApp"
        and c.get("type") == "group"
        and c.get("title") not in excluded_groups
    ]


def parse_beeper_message(msg: dict, room_name: str) -> dict[str, Any] | None:
    """Convert a Beeper API message to our message format.

    Returns None for non-text messages (reactions, system events).
    """
    if msg.get("type") not in ("TEXT", "IMAGE", "VIDEO", "AUDIO", "FILE"):
        return None

    text = msg.get("text", "") or ""
    if not text.strip():
        return None

    ts_str = msg["timestamp"].replace("Z", "+00:00")
    from datetime import datetime
    ts_ms = int(datetime.fromisoformat(ts_str).timestamp() * 1000)

    sender_name = msg.get("senderName", "")
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


def load_cursor(db_path: Path, chat_id: str) -> str | None:
    """Load the last-seen sortKey for a chat."""
    conn = get_connection(db_path)
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key = ?",
        (f"beeper_cursor:{chat_id}",),
    ).fetchone()
    conn.close()
    return row[0] if row else None


def save_cursor(db_path: Path, chat_id: str, cursor: str) -> None:
    """Save the last-seen sortKey for a chat."""
    conn = get_connection(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        (f"beeper_cursor:{chat_id}", cursor),
    )
    conn.commit()
    conn.close()


def save_active_groups(db_path: Path, groups: list[dict]) -> None:
    """Persist currently monitored WhatsApp groups for downstream analytics scoping."""
    group_ids = [str(g.get("id", "")).strip() for g in groups if str(g.get("id", "")).strip()]
    group_names = [str(g.get("title", "")).strip() for g in groups if str(g.get("title", "")).strip()]
    conn = get_connection(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        ("beeper_active_group_ids", json.dumps(group_ids)),
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        ("beeper_active_group_names", json.dumps(group_names)),
    )
    conn.commit()
    conn.close()


def fetch_new_messages(
    base_url: str, token: str, chat_id: str, after_cursor: str | None,
) -> tuple[list[dict], str | None]:
    """Fetch new messages for a chat since the given cursor.

    Returns (messages, newest_cursor).
    """
    encoded = urllib.parse.quote(chat_id, safe="")
    all_items: list[dict] = []

    if after_cursor:
        # Get messages newer than our cursor
        params = {"cursor": after_cursor, "direction": "after"}
    else:
        # First run — just get the latest page
        params = {}

    data = api_get(base_url, f"/v1/chats/{encoded}/messages", token, params)
    items = data.get("items", [])
    all_items.extend(items)

    # Continue paginating if there are more newer messages
    while data.get("hasMore", False) and items:
        newest_sk = items[0]["sortKey"]
        data = api_get(
            base_url, f"/v1/chats/{encoded}/messages", token,
            {"cursor": newest_sk, "direction": "after"},
        )
        items = data.get("items", [])
        all_items.extend(items)

    newest_cursor = all_items[0]["sortKey"] if all_items else after_cursor
    return all_items, newest_cursor


def save_messages(db_path: Path, messages: list[dict[str, Any]]) -> int:
    """Save messages to the database. Returns count of new messages inserted."""
    if not messages:
        return 0
    conn = get_connection(db_path)
    count = 0
    for msg in messages:
        try:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO messages
                   (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (msg["id"], msg["room_id"], msg["room_name"], msg["sender_id"],
                 msg["sender_name"], msg["body"], msg["timestamp"], msg["raw_event"]),
            )
            count += cursor.rowcount
        except Exception:
            logger.exception("Failed to insert message %s", msg["id"])
    conn.commit()
    conn.close()
    return count


def poll_once(
    db_path: Path, base_url: str, token: str, groups: list[dict],
) -> list[dict[str, Any]]:
    """Poll all groups once for new messages. Returns list of new parsed messages."""
    all_new: list[dict[str, Any]] = []

    for group in groups:
        chat_id = group["id"]
        title = group["title"]
        cursor = load_cursor(db_path, chat_id)

        try:
            raw_msgs, new_cursor = fetch_new_messages(base_url, token, chat_id, cursor)
        except Exception:
            logger.exception("Failed to fetch messages for %s", title)
            continue

        parsed = [m for raw in raw_msgs if (m := parse_beeper_message(raw, title)) is not None]

        if parsed:
            saved = save_messages(db_path, parsed)
            if saved > 0:
                logger.info("%s: %d new messages", title, saved)
                all_new.extend(parsed[:saved])
                publish_event(
                    "vibez.messages.synced",
                    f"sync-{chat_id}-{int(time.time())}",
                    f"vibez:sync:{chat_id}:{int(time.time())}",
                    {"count": saved, "room": title},
                )

        if new_cursor and new_cursor != cursor:
            save_cursor(db_path, chat_id, new_cursor)

    return all_new


async def sync_loop(
    db_path: Path,
    api_base: str,
    api_token: str,
    poll_interval: int = POLL_INTERVAL,
    on_messages=None,
) -> None:
    """Main sync loop. Polls the Beeper Desktop API for new messages."""
    import asyncio

    init_db(db_path)
    backoff = 1

    check_token_health(api_base, api_token)
    logger.info("Discovering WhatsApp groups...")
    groups = get_whatsapp_groups(api_base, api_token)
    logger.info("Monitoring %d WhatsApp groups", len(groups))
    for g in groups:
        logger.info("  - %s", g["title"])
    save_active_groups(db_path, groups)

    # Initialize cursors for any groups we haven't seen before
    for group in groups:
        cursor = load_cursor(db_path, group["id"])
        if cursor is None:
            # Set cursor to the newest message so we only capture new messages going forward
            encoded = urllib.parse.quote(group["id"], safe="")
            try:
                data = api_get(api_base, f"/v1/chats/{encoded}/messages", api_token)
                items = data.get("items", [])
                if items:
                    save_cursor(db_path, group["id"], items[0]["sortKey"])
                    logger.info("  Initialized cursor for %s at sortKey %s", group["title"], items[0]["sortKey"])
            except Exception:
                logger.warning("  Could not initialize cursor for %s", group["title"])

    while True:
        try:
            new_messages = poll_once(db_path, api_base, api_token, groups)

            if new_messages and on_messages:
                await on_messages(new_messages)

            backoff = 1
            await asyncio.sleep(poll_interval)

        except urllib.error.HTTPError as e:
            if e.code == 401:
                logger.error("Beeper API token expired or invalid (401). Stopping.")
                raise
            logger.error("HTTP error %d. Retrying in %ds", e.code, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 300)
        except Exception:
            logger.exception("Error in sync loop. Retrying in %ds", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 300)
