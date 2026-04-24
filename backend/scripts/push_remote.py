"""Push local vibez SQLite rows into a remote vibez deployment.

This script is intended for local-to-cloud sync:
1) local machine ingests Beeper Desktop API + Google Groups into local vibez.db
2) this script batches recent rows and upserts them into remote /api/admin/push
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

DEFAULT_ANALYSIS_SYNC_STATE_KEYS = (
    "beeper_active_group_ids",
    "beeper_active_group_names",
    "google_groups_active_group_keys",
    "wisdom_last_run",
    "links_last_refresh_ts",
)
DEFAULT_SYNC_STATE_KEYS = DEFAULT_ANALYSIS_SYNC_STATE_KEYS
EMBEDDING_BATCH_SIZE = 100
_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


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


def load_allowed_groups() -> set[str]:
    raw = os.environ.get("VIBEZ_ALLOWED_GROUPS", "").strip()
    if not raw:
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def fetch_records(
    db_path: Path,
    cutoff_ts: int | None,
    allowed_groups: set[str],
    excluded_groups: set[str],
) -> list[dict[str, Any]]:
    allowed_groups_normalized = {item.strip().casefold() for item in allowed_groups}
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
        if allowed_groups_normalized and room_name.strip().casefold() not in allowed_groups_normalized:
            continue
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


def fetch_sync_state(
    db_path: Path,
    allowed_groups: set[str],
    excluded_groups: set[str],
) -> dict[str, str]:
    allowed_groups_normalized = {item.strip().casefold() for item in allowed_groups}
    conn = sqlite3.connect(str(db_path))
    cursor = conn.execute(
        f"""
        SELECT key, value
        FROM sync_state
        WHERE key IN ({",".join("?" for _ in DEFAULT_ANALYSIS_SYNC_STATE_KEYS)})
        """,
        DEFAULT_ANALYSIS_SYNC_STATE_KEYS,
    )
    rows = cursor.fetchall()
    conn.close()
    state = {str(key): str(value) for key, value in rows}
    if not allowed_groups and not excluded_groups:
        return state

    names = parse_json_array(state.get("beeper_active_group_names"))
    ids = parse_json_array(state.get("beeper_active_group_ids"))
    if names and ids and len(names) == len(ids):
        filtered_pairs = [
            (group_id, name)
            for group_id, name in zip(ids, names)
            if (
                not allowed_groups_normalized
                or name.strip().casefold() in allowed_groups_normalized
            )
            and name.strip().lower() not in excluded_groups
        ]
        state["beeper_active_group_ids"] = json.dumps(
            [pair[0] for pair in filtered_pairs]
        )
        state["beeper_active_group_names"] = json.dumps(
            [pair[1] for pair in filtered_pairs]
        )
    google_group_keys = parse_json_array(state.get("google_groups_active_group_keys"))
    if google_group_keys:
        filtered_google_group_keys = [
            group_key
            for group_key in google_group_keys
            if (
                not allowed_groups_normalized
                or group_key.strip().casefold() in allowed_groups_normalized
            )
        ]
        state["google_groups_active_group_keys"] = json.dumps(filtered_google_group_keys)
    return state


def _fetch_rows(db_path: Path, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def _validate_ident(raw: str, label: str) -> str:
    value = (raw or "").strip().lower()
    if not value or not _IDENT_RE.fullmatch(value):
        raise ValueError(f"Invalid {label}: {raw!r}")
    return value


def _import_psycopg():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required to push pgvector embeddings. Install with: pip install 'psycopg[binary]>=3.2'"
        ) from exc
    return psycopg


def fetch_message_embeddings(
    allowed_groups: set[str],
    excluded_groups: set[str],
    *,
    cutoff_ts: int | None = None,
) -> list[dict[str, Any]]:
    pg_url = os.environ.get("VIBEZ_PGVECTOR_URL", "").strip()
    if not pg_url:
        return []
    table = _validate_ident(
        os.environ.get("VIBEZ_PGVECTOR_TABLE", "vibez_message_embeddings"),
        "VIBEZ_PGVECTOR_TABLE",
    )
    psycopg = _import_psycopg()
    params: list[Any] = []
    where_parts: list[str] = []
    if cutoff_ts is not None:
        params.append(int(cutoff_ts))
        where_parts.append("timestamp >= %s")
    if allowed_groups:
        params.append([item.strip().casefold() for item in allowed_groups if item.strip()])
        where_parts.append("lower(room_name) = ANY(%s)")
    if excluded_groups:
        params.append([item.strip().lower() for item in excluded_groups if item.strip()])
        where_parts.append("NOT (lower(room_name) = ANY(%s))")
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    sql = f"""
        SELECT message_id, room_id, room_name, sender_id, sender_name, body, timestamp,
               relevance_score, topics::text AS topics, entities::text AS entities,
               contribution_flag, contribution_themes::text AS contribution_themes,
               contribution_hint, alert_level, embedding::text AS embedding
        FROM {table}
        {where_sql}
        ORDER BY timestamp ASC, message_id ASC
    """
    with psycopg.connect(pg_url) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            columns = [desc.name for desc in cur.description]
            return [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]


def fetch_link_embeddings(
    allowed_groups: set[str],
    excluded_groups: set[str],
    *,
    cutoff_ts: int | None = None,
) -> list[dict[str, Any]]:
    pg_url = os.environ.get("VIBEZ_PGVECTOR_URL", "").strip()
    if not pg_url:
        return []
    table = _validate_ident(
        os.environ.get("VIBEZ_PGVECTOR_LINK_TABLE", "vibez_link_embeddings"),
        "VIBEZ_PGVECTOR_LINK_TABLE",
    )
    psycopg = _import_psycopg()
    params: list[Any] = []
    where_parts: list[str] = []
    if cutoff_ts is not None:
        cutoff_iso = datetime.fromtimestamp(cutoff_ts / 1000, tz=timezone.utc).isoformat()
        params.append(cutoff_iso)
        where_parts.append("COALESCE(last_seen, '') >= %s")
    if allowed_groups:
        params.append([item.strip().casefold() for item in allowed_groups if item.strip()])
        where_parts.append("lower(source_group) = ANY(%s)")
    if excluded_groups:
        params.append([item.strip().lower() for item in excluded_groups if item.strip()])
        where_parts.append("NOT (lower(source_group) = ANY(%s))")
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    sql = f"""
        SELECT link_id, url, url_hash, title, category, relevance, shared_by, source_group,
               first_seen, last_seen, mention_count, value_score, report_date::text AS report_date, authored_by,
               pinned, embedding::text AS embedding
        FROM {table}
        {where_sql}
        ORDER BY COALESCE(last_seen, '') ASC, link_id ASC
    """
    with psycopg.connect(pg_url) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            columns = [desc.name for desc in cur.description]
            return [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]


def fetch_links(db_path: Path) -> list[dict[str, Any]]:
    return _fetch_rows(
        db_path,
        """
        SELECT url, url_hash, title, category, relevance, shared_by, source_group,
               first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned
        FROM links
        ORDER BY last_seen ASC, url_hash ASC
        """,
    )


def fetch_daily_reports(db_path: Path) -> list[dict[str, Any]]:
    return _fetch_rows(
        db_path,
        """
        SELECT report_date, briefing_md, briefing_json, contributions, trends,
               daily_memo, conversation_arcs, stats, generated_at
        FROM daily_reports
        ORDER BY report_date ASC
        """,
    )


def fetch_wisdom_topics(db_path: Path) -> list[dict[str, Any]]:
    return _fetch_rows(
        db_path,
        """
        SELECT name, slug, summary, message_count, contributor_count,
               last_active, created_at, updated_at
        FROM wisdom_topics
        ORDER BY slug ASC
        """,
    )


def fetch_wisdom_items(db_path: Path) -> list[dict[str, Any]]:
    return _fetch_rows(
        db_path,
        """
        SELECT wt.slug AS topic_slug, wi.knowledge_type, wi.title, wi.summary,
               wi.source_links, wi.source_messages, wi.contributors, wi.confidence,
               wi.created_at, wi.updated_at
        FROM wisdom_items wi
        JOIN wisdom_topics wt ON wt.id = wi.topic_id
        ORDER BY wt.slug ASC, lower(wi.title) ASC
        """,
    )


def fetch_wisdom_recommendations(db_path: Path) -> list[dict[str, Any]]:
    return _fetch_rows(
        db_path,
        """
        SELECT source.slug AS from_topic_slug, target.slug AS to_topic_slug,
               wr.strength, wr.reason
        FROM wisdom_recommendations wr
        JOIN wisdom_topics source ON source.id = wr.from_topic_id
        JOIN wisdom_topics target ON target.id = wr.to_topic_id
        ORDER BY source.slug ASC, target.slug ASC
        """,
    )


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


def push_section(
    remote_url: str,
    push_key: str,
    access_cookie: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    endpoint = urllib.parse.urljoin(remote_url.rstrip("/") + "/", "api/admin/push")
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
        raise RuntimeError(f"Remote push rejected payload: {result}")
    return result


def push_batches(
    remote_url: str,
    push_key: str,
    access_cookie: str,
    records: list[dict[str, Any]],
    sync_state: dict[str, str],
    batch_size: int,
) -> tuple[int, int]:
    messages_written = 0
    batches = 0

    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        payload: dict[str, Any] = {"records": batch}
        if i == 0 and sync_state:
            payload["sync_state"] = sync_state

        result = push_section(remote_url, push_key, access_cookie, payload)

        batches += 1
        messages_written += int(result.get("messages_written", 0))
        print(
            f"  batch {batches}: pushed {len(batch)} records "
            f"(remote messages_written={result.get('messages_written', 0)})",
            flush=True,
        )

    return messages_written, batches


def push_analysis_tables(
    remote_url: str,
    push_key: str,
    access_cookie: str,
    db_path: Path,
    sync_state: dict[str, str],
    batch_size: int,
    *,
    cutoff_ts: int | None = None,
    allowed_groups: set[str] | None = None,
    excluded_groups: set[str] | None = None,
) -> None:
    resolved_allowed = allowed_groups or set()
    resolved_excluded = excluded_groups or set()
    sections: list[tuple[str, list[dict[str, Any]]]] = [
        ("links", fetch_links(db_path)),
        ("daily_reports", fetch_daily_reports(db_path)),
        ("wisdom_topics", fetch_wisdom_topics(db_path)),
        ("wisdom_items", fetch_wisdom_items(db_path)),
        ("wisdom_recommendations", fetch_wisdom_recommendations(db_path)),
        (
            "message_embeddings",
            fetch_message_embeddings(
                resolved_allowed,
                resolved_excluded,
                cutoff_ts=cutoff_ts,
            ),
        ),
        (
            "link_embeddings",
            fetch_link_embeddings(
                resolved_allowed,
                resolved_excluded,
                cutoff_ts=cutoff_ts,
            ),
        ),
    ]
    for section_name, rows in sections:
        if not rows:
            continue
        resolved_batch_size = (
            min(batch_size, EMBEDDING_BATCH_SIZE)
            if section_name.endswith("embeddings")
            else batch_size
        )
        for i in range(0, len(rows), resolved_batch_size):
            batch = rows[i : i + resolved_batch_size]
            result = push_section(
                remote_url,
                push_key,
                access_cookie,
                {section_name: batch},
            )
            print(
                f"  {section_name} batch {(i // batch_size) + 1}: pushed {len(batch)} rows "
                f"(remote {section_name}_written={result.get(f'{section_name}_written', 0)})",
                flush=True,
            )
    if sync_state:
        push_section(remote_url, push_key, access_cookie, {"sync_state": sync_state})
        print(f"  sync_state: pushed {len(sync_state)} keys", flush=True)


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
    allowed_groups = load_allowed_groups()
    excluded_groups = load_excluded_groups()
    records = fetch_records(db_path, cutoff_ts, allowed_groups, excluded_groups)
    sync_state = fetch_sync_state(db_path, allowed_groups, excluded_groups)

    window_label = "all-time" if cutoff_ts is None else f"last {args.lookback_days}d"
    print(f"Local DB: {db_path}")
    print(f"Window: {window_label}")
    if allowed_groups:
        print(f"Allowed groups: {', '.join(sorted(allowed_groups))}")
    if excluded_groups:
        print(f"Excluded groups: {', '.join(sorted(excluded_groups))}")
    print(f"Records to push: {len(records)}")
    print(f"Sync state keys: {len(sync_state)}")

    if args.dry_run:
        print("Dry run only; no remote writes.")
        return 0

    access_cookie = login_access_cookie(remote_url, access_code)
    messages_written = 0
    batches = 0
    if records:
        messages_written, batches = push_batches(
            remote_url=remote_url,
            push_key=push_key,
            access_cookie=access_cookie,
            records=records,
            sync_state=sync_state,
            batch_size=batch_size,
        )
    else:
        print("No raw message rows to push in this window.", flush=True)

    push_analysis_tables(
        remote_url=remote_url,
        push_key=push_key,
        access_cookie=access_cookie,
        db_path=db_path,
        sync_state=sync_state if not records else {},
        batch_size=batch_size,
        cutoff_ts=cutoff_ts,
        allowed_groups=allowed_groups,
        excluded_groups=excluded_groups,
    )
    print(
        f"Push complete: {len(records)} records over {batches} message batches "
        f"(remote messages_written={messages_written})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
