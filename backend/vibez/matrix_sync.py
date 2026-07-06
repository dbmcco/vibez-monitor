"""Matrix sync service — connects to Beeper's Matrix API and captures WhatsApp messages."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from vibez.config import Config
from vibez.db import get_connection, init_db

logger = logging.getLogger("vibez.sync")


def _matrix_message_id(event_id: str, source_name: str | None) -> str:
    if not source_name:
        return event_id
    return f"matrix:{source_name}:{event_id}"


def _sender_name_from_mxid(sender_id: str) -> str:
    localpart = sender_id.split(":", 1)[0].lstrip("@")
    if localpart.startswith("whatsapp_"):
        localpart = localpart.removeprefix("whatsapp_")
        if localpart.isdigit():
            return f"+{localpart}"
    return localpart


def parse_message_event(
    event: dict[str, Any],
    room_id: str,
    room_name: str,
    source_name: str | None = None,
) -> dict[str, Any] | None:
    """Parse a Matrix m.room.message event into our message format."""
    if event.get("type") != "m.room.message":
        return None

    content = event.get("content", {})
    sender_name = (
        content.get("com.beeper.sender_name", "")
        or content.get("com.mautrix.displayname", "")
        or content.get("displayname", "")
    )
    if not sender_name:
        sender_id = event.get("sender", "")
        sender_name = _sender_name_from_mxid(sender_id)

    return {
        "id": _matrix_message_id(event["event_id"], source_name),
        "room_id": room_id,
        "room_name": room_name,
        "sender_id": event.get("sender", ""),
        "sender_name": sender_name,
        "body": content.get("body", ""),
        "timestamp": event.get("origin_server_ts", 0),
        "raw_event": json.dumps(event),
    }


def filter_whatsapp_rooms(
    rooms_state: dict[str, Any],
) -> dict[str, str]:
    """Given room join state from a sync response, return {room_id: room_name} for WhatsApp rooms."""
    wa_rooms: dict[str, str] = {}
    for room_id, room_data in rooms_state.items():
        state_events = room_data.get("state", {}).get("events", [])
        is_whatsapp = False
        room_name = room_id
        for ev in state_events:
            if ev.get("type") == "m.bridge":
                content = ev.get("content", {})
                bridge_name = content.get("com.beeper.bridge_name", "")
                protocol = content.get("protocol", {})
                protocol_id = protocol.get("id", "") if isinstance(protocol, dict) else ""
                bridgebot = content.get("bridgebot", "")
                network = content.get("network", "")
                if (
                    bridge_name == "whatsapp"
                    or protocol_id == "whatsapp"
                    or network == "whatsapp"
                    or str(bridgebot).startswith("@whatsappbot:")
                ):
                    is_whatsapp = True
            if ev.get("type") == "m.room.name":
                room_name = ev.get("content", {}).get("name", room_id)
        if is_whatsapp:
            wa_rooms[room_id] = room_name
    return wa_rooms


def extract_messages_from_sync(
    sync_response: dict[str, Any],
    known_rooms: dict[str, str],
    source_name: str | None = None,
) -> list[dict[str, Any]]:
    """Extract messages from a sync response, filtering to known WhatsApp rooms."""
    messages = []
    join_rooms = sync_response.get("rooms", {}).get("join", {})
    for room_id, room_data in join_rooms.items():
        if room_id not in known_rooms:
            continue
        room_name = known_rooms[room_id]
        timeline_events = room_data.get("timeline", {}).get("events", [])
        for event in timeline_events:
            msg = parse_message_event(event, room_id, room_name, source_name=source_name)
            if msg is not None:
                messages.append(msg)
    return messages


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


def matrix_sync_state_key(source_name: str | None = None) -> str:
    if not source_name:
        return "next_batch"
    return f"matrix_next_batch:{source_name}"


def load_sync_token(db_path: Path, source_name: str | None = None) -> str | None:
    """Load the next_batch sync token from the database."""
    conn = get_connection(db_path)
    cursor = conn.execute(
        "SELECT value FROM sync_state WHERE key = %s",
        (matrix_sync_state_key(source_name),),
    )
    row = cursor.fetchone()
    conn.close()
    return row[0] if row else None


def save_sync_token(db_path: Path, token: str, source_name: str | None = None) -> None:
    """Save the next_batch sync token."""
    conn = get_connection(db_path)
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (matrix_sync_state_key(source_name), token),
    )
    conn.commit()
    conn.close()


async def sync_loop(config: Config, on_messages=None) -> None:
    """Main sync loop. Long-polls the Matrix server continuously."""
    init_db(config.db_path)
    known_rooms: dict[str, str] = {}
    source_name = config.matrix_source_name
    next_batch = load_sync_token(config.db_path, source_name=source_name)
    backoff = 1

    headers = {"Authorization": f"Bearer {config.matrix_access_token}"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        while True:
            try:
                params: dict[str, Any] = {"timeout": config.sync_timeout_ms}
                if next_batch:
                    params["since"] = next_batch
                else:
                    params["filter"] = json.dumps(
                        {"room": {"timeline": {"limit": 1}, "state": {"lazy_load_members": True}}}
                    )

                resp = await client.get(
                    f"{config.matrix_homeserver}/_matrix/client/v3/sync",
                    params=params, headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()

                join_rooms = data.get("rooms", {}).get("join", {})
                new_wa_rooms = filter_whatsapp_rooms(join_rooms)
                if new_wa_rooms:
                    known_rooms.update(new_wa_rooms)
                    logger.info("WhatsApp rooms: %s", list(known_rooms.values()))

                messages = extract_messages_from_sync(
                    data,
                    known_rooms,
                    source_name=source_name,
                )
                if messages:
                    saved = save_messages(config.db_path, messages)
                    logger.info("Saved %d new messages (of %d)", saved, len(messages))
                    if on_messages and saved > 0:
                        await on_messages(messages)

                new_batch = data.get("next_batch", "")
                if new_batch:
                    next_batch = new_batch
                    save_sync_token(config.db_path, next_batch, source_name=source_name)

                backoff = 1

            except httpx.HTTPStatusError as e:
                logger.error("HTTP error %s: %s", e.response.status_code, e)
                if e.response.status_code == 429:
                    retry_after = int(e.response.headers.get("Retry-After", str(backoff)))
                    await asyncio.sleep(retry_after)
                else:
                    await asyncio.sleep(min(backoff, 300))
                    backoff = min(backoff * 2, 300)
            except (httpx.ConnectError, httpx.ReadTimeout) as e:
                logger.warning("Connection issue: %s. Retrying in %ds", e, backoff)
                await asyncio.sleep(min(backoff, 300))
                backoff = min(backoff * 2, 300)
            except Exception:
                logger.exception("Unexpected error in sync loop")
                await asyncio.sleep(min(backoff, 300))
                backoff = min(backoff * 2, 300)
