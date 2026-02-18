"""Backfill messages from Matrix room history (Jan 29 → now)."""

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.db import get_connection, init_db
from vibez.matrix_sync import filter_whatsapp_rooms, parse_message_event, save_messages


async def get_whatsapp_rooms(client: httpx.AsyncClient, config: Config) -> dict[str, str]:
    """Do an initial sync to discover WhatsApp rooms."""
    headers = {"Authorization": f"Bearer {config.matrix_access_token}"}
    resp = await client.get(
        f"{config.matrix_homeserver}/_matrix/client/v3/sync",
        params={"filter": json.dumps({"room": {"timeline": {"limit": 0}, "state": {"lazy_load_members": True}}})},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json()
    join_rooms = data.get("rooms", {}).get("join", {})
    return filter_whatsapp_rooms(join_rooms)


async def backfill_room(
    client: httpx.AsyncClient,
    config: Config,
    room_id: str,
    room_name: str,
    since_ts: int,
) -> int:
    """Backfill a single room from `since_ts` to now using /messages API."""
    headers = {"Authorization": f"Bearer {config.matrix_access_token}"}
    total_saved = 0
    end_token = None  # pagination token

    # First get the latest sync token for this room
    # Use /messages with dir=b (backwards) from now
    from_token = "END"  # special: start from the end (most recent)

    # Get initial token from /sync
    resp = await client.get(
        f"{config.matrix_homeserver}/_matrix/client/v3/sync",
        params={"filter": json.dumps({"room": {"rooms": [room_id], "timeline": {"limit": 1}}})},
        headers=headers,
    )
    resp.raise_for_status()
    sync_data = resp.json()
    # Get the prev_batch token from the room timeline
    room_data = sync_data.get("rooms", {}).get("join", {}).get(room_id, {})
    from_token = room_data.get("timeline", {}).get("prev_batch", "")
    if not from_token:
        print(f"  No prev_batch for {room_name}, skipping")
        return 0

    page = 0
    while True:
        page += 1
        resp = await client.get(
            f"{config.matrix_homeserver}/_matrix/client/v3/rooms/{room_id}/messages",
            params={"from": from_token, "dir": "b", "limit": 100},
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()

        events = data.get("chunk", [])
        if not events:
            break

        messages = []
        oldest_ts = None
        for event in events:
            msg = parse_message_event(event, room_id, room_name)
            if msg:
                messages.append(msg)
                ts = event.get("origin_server_ts", 0)
                if oldest_ts is None or ts < oldest_ts:
                    oldest_ts = ts

        if messages:
            saved = save_messages(config.db_path, messages)
            total_saved += saved

        # Check if we've gone past our target timestamp
        if oldest_ts and oldest_ts < since_ts:
            break

        # Get next pagination token
        from_token = data.get("end", "")
        if not from_token:
            break

        if page % 5 == 0:
            print(f"    page {page}: {total_saved} saved so far", flush=True)

    return total_saved


async def main():
    config = Config.from_env()
    init_db(config.db_path)

    # Find latest message timestamp in DB (Jan 29 cutoff)
    conn = get_connection(config.db_path)
    row = conn.execute("SELECT MAX(timestamp) FROM messages").fetchone()
    since_ts = row[0] if row[0] else 0
    conn.close()

    print(f"Backfilling from {since_ts} (latest in DB) to now", flush=True)

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        print("Discovering WhatsApp rooms...", flush=True)
        rooms = await get_whatsapp_rooms(client, config)
        print(f"Found {len(rooms)} WhatsApp rooms", flush=True)

        total = 0
        for room_id, room_name in rooms.items():
            print(f"\n  Backfilling: {room_name}", flush=True)
            saved = await backfill_room(client, config, room_id, room_name, since_ts)
            total += saved
            print(f"  → {saved} new messages", flush=True)

    print(f"\nDone! {total} new messages backfilled.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
