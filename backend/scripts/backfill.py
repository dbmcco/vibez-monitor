"""Import existing WhatsApp chat exports into the vibez-monitor database."""

import argparse
import asyncio
import json
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.db import init_db, get_connection

CONTROL_CHARS = {"\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\ufeff"}
TS_RE = re.compile(
    r"^\s*[\u200e\u200f\u202a\u202b\u202c\ufeff]*\[(\d{1,2}/\d{1,2}/\d{2,4}),\s+([0-9:]+\s*[AP]M)\]\s+(.*)$"
)

DEFAULT_EXPORT_DIR = Path(__file__).resolve().parents[2] / "exports"


def normalize_text(value: str) -> str:
    value = value.replace("\u202f", " ").replace("\u00a0", " ")
    return "".join(ch for ch in value if ch not in CONTROL_CHARS)


def parse_dt(date_str: str, time_str: str) -> datetime | None:
    time_str = time_str.replace("\u202f", " ").replace("\u00a0", " ").strip()
    fmts = ["%m/%d/%y %I:%M:%S %p", "%m/%d/%y %I:%M %p"]
    for fmt in fmts:
        try:
            return datetime.strptime(f"{date_str} {time_str}", fmt)
        except ValueError:
            pass
    return None


def parse_and_import(zip_path: Path, db_path: Path) -> list[dict]:
    """Parse a WhatsApp export zip and insert messages into the database."""
    group_name = zip_path.stem.replace("WhatsApp Chat - ", "").strip()

    with zipfile.ZipFile(zip_path) as zf:
        chat_files = [n for n in zf.namelist() if n.lower().endswith("_chat.txt")]
        if not chat_files:
            return []
        chat_text = zf.read(chat_files[0]).decode("utf-8", errors="replace")

    messages = []
    current = None
    detected_group = None

    def finalize(entry):
        nonlocal detected_group
        if not entry:
            return
        dt, sender, body = entry
        sender = normalize_text(sender).strip().lstrip("~").strip() if sender else None
        body = normalize_text(body).strip()
        if detected_group is None and sender and "end-to-end encrypted" in body.lower():
            detected_group = sender
            return
        if sender is None or sender == (detected_group or group_name):
            return  # Skip system messages
        msg_id = f"$backfill_{group_name.replace(' ', '_')}_{len(messages)}"
        ts_ms = int(dt.timestamp() * 1000) if dt else 0
        messages.append({
            "id": msg_id,
            "room_id": f"!backfill_{group_name.replace(' ', '_')}",
            "room_name": detected_group or group_name,
            "sender_id": f"@backfill_{sender.replace(' ', '_')}",
            "sender_name": sender,
            "body": body,
            "timestamp": ts_ms,
            "raw_event": json.dumps({"source": "backfill", "zip": zip_path.name}),
        })

    for raw_line in chat_text.splitlines():
        line = normalize_text(raw_line)
        match = TS_RE.match(line)
        if match:
            finalize(current)
            date_str, time_str, rest = match.groups()
            dt = parse_dt(date_str, time_str)
            sender = None
            body = rest
            if ": " in rest:
                sender, body = rest.split(": ", 1)
            current = (dt, sender, body)
        elif current:
            dt, sender, body = current
            current = (dt, sender, f"{body}\n{line}".strip())

    finalize(current)

    # Insert into database
    conn = get_connection(db_path)
    inserted = 0
    for msg in messages:
        try:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO messages
                   (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (msg["id"], msg["room_id"], msg["room_name"], msg["sender_id"],
                 msg["sender_name"], msg["body"], msg["timestamp"], msg["raw_event"]),
            )
            inserted += cursor.rowcount
        except Exception as e:
            print(f"  Error inserting: {e}")
    conn.commit()
    conn.close()
    print(f"  {zip_path.name}: {inserted} messages imported")
    return messages


def main():
    """Import exports without classification (classification is expensive and optional)."""
    parser = argparse.ArgumentParser(description="Import WhatsApp export zips into vibez.db")
    parser.add_argument(
        "--export-dir",
        default=str(DEFAULT_EXPORT_DIR),
        help="Directory containing WhatsApp export .zip files.",
    )
    args = parser.parse_args()

    export_dir = Path(args.export_dir).expanduser()
    config = Config.from_env()
    init_db(config.db_path)

    zip_paths = sorted(export_dir.glob("*.zip"))
    print(f"Found {len(zip_paths)} export zips in {export_dir}")
    if not zip_paths:
        print("No zip files found. Pass --export-dir to point at your chat export directory.")
        return

    total = 0
    for zp in zip_paths:
        msgs = parse_and_import(zp, config.db_path)
        total += len(msgs)

    print(f"\nTotal: {total} messages imported")
    print("\nTo classify these messages (costs ~$1-2), run:")
    print("  python backend/scripts/classify_backfill.py")


if __name__ == "__main__":
    main()
