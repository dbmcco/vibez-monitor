"""Push local vibez SQLite rows into a remote vibez deployment.

This script is intended for local-to-cloud sync:
1) local machine ingests Beeper Desktop API + Google Groups into local vibez.db
2) this script batches recent rows and upserts them into remote /api/admin/push
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

DEFAULT_SYNC_STATE_KEYS = (
    "beeper_active_group_ids",
    "beeper_active_group_names",
    "google_groups_active_group_keys",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Push local vibez data into a remote vibez deployment."
    )
    parser.add_argument(
        "--db-path",
        default="",
        help="Path to local vibez.db (defaults to VIBEZ_DB_PATH or ./vibez.db)",
    )
    parser.add_argument(
        "--remote-url",
        default="",
        help="Remote app URL (defaults to VIBEZ_REMOTE_URL)",
    )
    parser.add_argument(
        "--access-code",
        default="",
        help="Access code for /api/access (defaults to VIBEZ_ACCESS_CODE)",
    )
    parser.add_argument(
        "--push-key",
        default="",
        help="Push key for /api/admin/push (defaults to VIBEZ_PUSH_API_KEY)",
    )
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=2,
        help="How many days of data to push (0 = all rows). Default: 2",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=400,
        help="Records per push request. Default: 400",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print counts only, do not push.",
    )
    return parser.parse_args()


def clamp_batch_size(raw: int) -> int:
    if raw < 1:
        return 1
    if raw > 1000:
        return 1000
    return raw


def resolve_db_path(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    env_path = os.environ.get("VIBEZ_DB_PATH", "").strip()
    if env_path:
        return Path(env_path).expanduser().resolve()
    return Path("./vibez.db").resolve()


def resolve_cutoff_ts(lookback_days: int) -> int | None:
    if lookback_days <= 0:
        return None
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=lookback_days)
    return int(cutoff.timestamp() * 1000)


def parse_json_array(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def load_excluded_groups() -> set[str]:
    raw = (
        os.environ.get("VIBEZ_PUSH_EXCLUDED_GROUPS", "").strip()
        or os.environ.get("VIBEZ_PUBLIC_EXCLUDED_GROUPS", "").strip()
    )
    if not raw:
        return set()
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def fetch_records(
    db_path: Path,
    cutoff_ts: int | None,
    excluded_groups: set[str],
) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        """
        SELECT
            m.id,
            m.room_id,
            m.room_name,
            m.sender_id,
            m.sender_name,
            m.body,
            m.timestamp,
            m.raw_event,
            c.relevance_score,
            c.topics,
            c.entities,
            c.contribution_flag,
            c.contribution_themes,
            c.contribution_hint,
            c.alert_level
        FROM messages m
        LEFT JOIN classifications c ON c.message_id = m.id
        WHERE (? IS NULL OR m.timestamp >= ?)
        ORDER BY m.timestamp ASC
        """,
        (cutoff_ts, cutoff_ts),
    )
    rows = cursor.fetchall()
    conn.close()

    records: list[dict[str, Any]] = []
    for row in rows:
        room_name = str(row["room_name"] or "")
        if room_name.strip().lower() in excluded_groups:
            continue
        message = {
            "id": str(row["id"]),
            "room_id": str(row["room_id"]),
            "room_name": room_name,
            "sender_id": str(row["sender_id"]),
            "sender_name": str(row["sender_name"]),
            "body": str(row["body"] or ""),
            "timestamp": int(row["timestamp"] or 0),
            "raw_event": str(row["raw_event"] or "{}"),
        }
        classification = None
        if row["relevance_score"] is not None:
            classification = {
                "relevance_score": int(row["relevance_score"] or 0),
                "topics": parse_json_array(row["topics"]),
                "entities": parse_json_array(row["entities"]),
                "contribution_flag": bool(row["contribution_flag"] or 0),
                "contribution_themes": parse_json_array(row["contribution_themes"]),
                "contribution_hint": str(row["contribution_hint"] or ""),
                "alert_level": str(row["alert_level"] or "none"),
            }
        records.append({"message": message, "classification": classification})
    return records


def fetch_sync_state(db_path: Path, excluded_groups: set[str]) -> dict[str, str]:
    conn = sqlite3.connect(str(db_path))
    cursor = conn.execute(
        f"""
        SELECT key, value
        FROM sync_state
        WHERE key IN ({",".join("?" for _ in DEFAULT_SYNC_STATE_KEYS)})
        """,
        DEFAULT_SYNC_STATE_KEYS,
    )
    rows = cursor.fetchall()
    conn.close()
    state = {str(key): str(value) for key, value in rows}
    if not excluded_groups:
        return state

    names = parse_json_array(state.get("beeper_active_group_names"))
    ids = parse_json_array(state.get("beeper_active_group_ids"))
    if names and ids and len(names) == len(ids):
        filtered_pairs = [
            (group_id, name)
            for group_id, name in zip(ids, names)
            if name.strip().lower() not in excluded_groups
        ]
        state["beeper_active_group_ids"] = json.dumps(
            [pair[0] for pair in filtered_pairs]
        )
        state["beeper_active_group_names"] = json.dumps(
            [pair[1] for pair in filtered_pairs]
        )
    return state


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout: int = 120,
) -> tuple[dict[str, Any], dict[str, str]]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        if value:
            req.add_header(key, value)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            header_map = {k.lower(): v for k, v in resp.headers.items()}
            if not raw:
                return {}, header_map
            return json.loads(raw), header_map
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed ({exc.code}): {detail}") from exc


def login_access_cookie(remote_url: str, access_code: str) -> str:
    url = urllib.parse.urljoin(remote_url.rstrip("/") + "/", "api/access")
    response, headers = request_json(
        "POST",
        url,
        {"code": access_code},
        headers={},
        timeout=60,
    )
    if not response.get("ok"):
        raise RuntimeError("Access code login failed.")
    set_cookie = headers.get("set-cookie", "")
    if not set_cookie:
        raise RuntimeError("Missing access cookie from /api/access response.")
    return set_cookie.split(";", 1)[0]


def push_batches(
    remote_url: str,
    push_key: str,
    access_cookie: str,
    records: list[dict[str, Any]],
    sync_state: dict[str, str],
    batch_size: int,
) -> tuple[int, int]:
    endpoint = urllib.parse.urljoin(remote_url.rstrip("/") + "/", "api/admin/push")
    messages_written = 0
    batches = 0

    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        payload: dict[str, Any] = {"records": batch}
        if i == 0 and sync_state:
            payload["sync_state"] = sync_state

        result, _ = request_json(
            "POST",
            endpoint,
            payload,
            headers={
                "x-vibez-push-key": push_key,
                "Cookie": access_cookie,
            },
        )
        if not result.get("ok"):
            raise RuntimeError(f"Remote push rejected batch at offset {i}: {result}")

        batches += 1
        messages_written += int(result.get("messages_written", 0))
        print(
            f"  batch {batches}: pushed {len(batch)} records "
            f"(remote messages_written={result.get('messages_written', 0)})",
            flush=True,
        )

    return messages_written, batches


def main() -> int:
    load_dotenv()
    args = parse_args()

    db_path = resolve_db_path(args.db_path)
    if not db_path.exists():
        print(f"Local db not found: {db_path}", file=sys.stderr)
        return 2

    remote_url = (args.remote_url or os.environ.get("VIBEZ_REMOTE_URL", "")).strip()
    access_code = (args.access_code or os.environ.get("VIBEZ_ACCESS_CODE", "")).strip()
    push_key = (args.push_key or os.environ.get("VIBEZ_PUSH_API_KEY", "")).strip()
    if not remote_url:
        print("Missing remote URL. Set VIBEZ_REMOTE_URL or pass --remote-url.", file=sys.stderr)
        return 2
    if not access_code:
        print(
            "Missing access code. Set VIBEZ_ACCESS_CODE or pass --access-code.",
            file=sys.stderr,
        )
        return 2
    if not push_key:
        print(
            "Missing push key. Set VIBEZ_PUSH_API_KEY or pass --push-key.",
            file=sys.stderr,
        )
        return 2

    batch_size = clamp_batch_size(args.batch_size)
    cutoff_ts = resolve_cutoff_ts(args.lookback_days)
    excluded_groups = load_excluded_groups()
    records = fetch_records(db_path, cutoff_ts, excluded_groups)
    sync_state = fetch_sync_state(db_path, excluded_groups)

    window_label = "all-time" if cutoff_ts is None else f"last {args.lookback_days}d"
    print(f"Local DB: {db_path}")
    print(f"Window: {window_label}")
    if excluded_groups:
        print(f"Excluded groups: {', '.join(sorted(excluded_groups))}")
    print(f"Records to push: {len(records)}")
    print(f"Sync state keys: {len(sync_state)}")

    if not records:
        print("Nothing to push.")
        return 0
    if args.dry_run:
        print("Dry run only; no remote writes.")
        return 0

    access_cookie = login_access_cookie(remote_url, access_code)
    messages_written, batches = push_batches(
        remote_url=remote_url,
        push_key=push_key,
        access_cookie=access_cookie,
        records=records,
        sync_state=sync_state,
        batch_size=batch_size,
    )
    print(
        f"Push complete: {len(records)} records over {batches} batches "
        f"(remote messages_written={messages_written})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
