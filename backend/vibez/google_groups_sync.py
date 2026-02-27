"""Google Groups sync via IMAP email delivery.

This source is optional and can run alongside Beeper sync. It ingests
Google Group emails delivered to a mailbox (for example Gmail) and
normalizes them into the shared `messages` table.
"""

from __future__ import annotations

import asyncio
import email
import hashlib
import imaplib
import json
import logging
import re
import time
from datetime import datetime, timezone
from email import policy
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any

from vibez.db import get_connection, init_db
from vibez.paia_events_adapter import publish_event

logger = logging.getLogger("vibez.google_groups_sync")

_GOOGLE_GROUPS_DOMAIN = "googlegroups.com"
_QUOTE_BREAK_RE = re.compile(r"^On .+wrote:\s*$", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def _decode_mime(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value))).strip()
    except Exception:
        return value.strip()


def canonical_group_key(value: str | None) -> str:
    """Canonicalize group identifiers into a stable slug-like key."""
    text = _decode_mime(value).strip().lower()
    if not text:
        return ""
    if "<" in text and ">" in text:
        text = text[text.find("<") + 1 : text.rfind(">")]
    text = text.strip(" <>\"'")
    if "@" in text:
        text = text.split("@", 1)[0]
    if f".{_GOOGLE_GROUPS_DOMAIN}" in text:
        text = text.split(f".{_GOOGLE_GROUPS_DOMAIN}", 1)[0]
    text = re.sub(r"[^a-z0-9._-]+", "-", text).strip("-._")
    return text


def _extract_group_key(msg: Message) -> str:
    for header in ("List-Id", "X-Google-Loop"):
        key = canonical_group_key(msg.get(header))
        if key:
            return key
    for header in ("To", "Cc", "Delivered-To"):
        decoded = _decode_mime(msg.get(header))
        if not decoded:
            continue
        for _name, addr in email.utils.getaddresses([decoded]):
            addr = (addr or "").strip().lower()
            if addr.endswith(f"@{_GOOGLE_GROUPS_DOMAIN}"):
                return canonical_group_key(addr)
    return ""


def _decode_part_payload(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        raw = part.get_payload()
        return str(raw or "")
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except Exception:
        return payload.decode("utf-8", errors="replace")


def _extract_text_body(msg: Message) -> str:
    plain_parts: list[str] = []
    html_parts: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            disposition = (part.get("Content-Disposition") or "").lower()
            if "attachment" in disposition:
                continue
            ctype = part.get_content_type().lower()
            if ctype == "text/plain":
                plain_parts.append(_decode_part_payload(part))
            elif ctype == "text/html":
                html_parts.append(_decode_part_payload(part))
    else:
        ctype = msg.get_content_type().lower()
        if ctype == "text/html":
            html_parts.append(_decode_part_payload(msg))
        else:
            plain_parts.append(_decode_part_payload(msg))

    if plain_parts:
        return "\n".join(text for text in plain_parts if text.strip())
    if html_parts:
        stripped = _TAG_RE.sub(" ", "\n".join(html_parts))
        return re.sub(r"\s+", " ", stripped).strip()
    return ""


def _strip_quoted_text(text: str) -> str:
    lines = text.splitlines()
    kept: list[str] = []
    for line in lines:
        compact = line.strip()
        if _QUOTE_BREAK_RE.match(compact):
            break
        if compact.startswith(">"):
            continue
        if compact.lower().startswith("from: ") and kept:
            break
        kept.append(line)
    cleaned = "\n".join(kept).strip()
    return re.sub(r"\n{3,}", "\n\n", cleaned)


def parse_group_email(
    raw_email: bytes,
    uid: int,
    allowed_groups: set[str],
) -> dict[str, Any] | None:
    """Parse an RFC822 message into a normalized vibez message row."""
    msg = email.message_from_bytes(raw_email, policy=policy.default)
    group_key = _extract_group_key(msg)
    if not group_key:
        return None
    if allowed_groups and group_key not in allowed_groups:
        return None

    sender_decoded = _decode_mime(msg.get("From"))
    sender_name_raw, sender_addr = parseaddr(sender_decoded)
    sender_name = sender_name_raw.strip() or sender_addr.split("@")[0] or "Unknown"
    sender_id = sender_addr.lower() if sender_addr else sender_name.lower()

    body = _strip_quoted_text(_extract_text_body(msg))
    if not body:
        return None

    date_header = _decode_mime(msg.get("Date"))
    try:
        dt = parsedate_to_datetime(date_header) if date_header else None
    except Exception:
        dt = None
    if dt is None:
        dt = datetime.now(tz=timezone.utc)
    elif dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ts_ms = int(dt.timestamp() * 1000)

    message_id = (_decode_mime(msg.get("Message-Id")) or _decode_mime(msg.get("Message-ID"))).strip()
    stable_source = message_id or f"{group_key}:{uid}:{date_header}:{sender_id}"
    digest = hashlib.sha1(stable_source.encode("utf-8")).hexdigest()[:24]

    subject = _decode_mime(msg.get("Subject"))
    raw_event = json.dumps(
        {
            "source": "google_groups_imap",
            "uid": uid,
            "list_id": _decode_mime(msg.get("List-Id")),
            "group_key": group_key,
            "message_id": message_id,
            "subject": subject,
            "from": sender_decoded,
            "date": date_header,
        },
        ensure_ascii=False,
    )

    return {
        "id": f"googlegroup-{group_key}-{digest}",
        "room_id": f"googlegroup:{group_key}",
        "room_name": group_key,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "body": body,
        "timestamp": ts_ms,
        "raw_event": raw_event,
    }


def _load_uid_cursor(db_path: Path, mailbox: str) -> int | None:
    conn = get_connection(db_path)
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key = ?",
        (f"google_groups_uid_cursor:{mailbox}",),
    ).fetchone()
    conn.close()
    if not row:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


def _save_uid_cursor(db_path: Path, mailbox: str, uid: int) -> None:
    conn = get_connection(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        (f"google_groups_uid_cursor:{mailbox}", str(uid)),
    )
    conn.commit()
    conn.close()


def _save_active_groups(db_path: Path, groups: set[str]) -> None:
    conn = get_connection(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
        ("google_groups_active_group_keys", json.dumps(sorted(groups))),
    )
    conn.commit()
    conn.close()


def _save_messages(db_path: Path, messages: list[dict[str, Any]]) -> int:
    if not messages:
        return 0
    conn = get_connection(db_path)
    count = 0
    for msg in messages:
        cursor = conn.execute(
            """INSERT OR IGNORE INTO messages
               (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg["id"],
                msg["room_id"],
                msg["room_name"],
                msg["sender_id"],
                msg["sender_name"],
                msg["body"],
                msg["timestamp"],
                msg["raw_event"],
            ),
        )
        count += cursor.rowcount
    conn.commit()
    conn.close()
    return count


def poll_once(
    db_path: Path,
    host: str,
    port: int,
    user: str,
    password: str,
    mailbox: str,
    group_keys: set[str],
) -> list[dict[str, Any]]:
    """Poll IMAP mailbox once and return newly parsed Google Groups messages."""
    uid_cursor = _load_uid_cursor(db_path, mailbox)
    with imaplib.IMAP4_SSL(host=host, port=port) as client:
        client.login(user, password)
        status, _ = client.select(mailbox, readonly=True)
        if status != "OK":
            raise RuntimeError(f"Could not select mailbox: {mailbox}")

        # First run: establish cursor at latest UID, don't backfill old mail.
        if uid_cursor is None:
            status, data = client.uid("SEARCH", None, "ALL")
            if status != "OK":
                return []
            raw = data[0] if data and data[0] else b""
            uids = [int(token) for token in raw.split() if token.isdigit()]
            if uids:
                _save_uid_cursor(db_path, mailbox, max(uids))
                logger.info(
                    "Initialized Google Groups cursor at UID %s (mailbox=%s)",
                    max(uids),
                    mailbox,
                )
            return []

        status, data = client.uid("SEARCH", None, f"{uid_cursor + 1}:*")
        if status != "OK":
            return []
        raw = data[0] if data and data[0] else b""
        uids = [int(token) for token in raw.split() if token.isdigit()]
        if not uids:
            return []

        parsed_messages: list[dict[str, Any]] = []
        max_uid = uid_cursor
        for uid in uids:
            max_uid = max(max_uid, uid)
            status, fetch_data = client.uid("FETCH", str(uid), "(RFC822)")
            if status != "OK" or not fetch_data:
                continue
            raw_email = b""
            for item in fetch_data:
                if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], bytes):
                    raw_email = item[1]
                    break
            if not raw_email:
                continue
            parsed = parse_group_email(raw_email, uid=uid, allowed_groups=group_keys)
            if parsed:
                parsed_messages.append(parsed)

        _save_uid_cursor(db_path, mailbox, max_uid)
        return parsed_messages


async def sync_loop(
    db_path: Path,
    host: str,
    port: int,
    user: str,
    password: str,
    mailbox: str,
    group_keys: set[str],
    poll_interval: int = 60,
    on_messages=None,
) -> None:
    """Continuously sync Google Groups messages from IMAP into sqlite."""
    init_db(db_path)
    _save_active_groups(db_path, group_keys)
    logger.info(
        "Starting Google Groups sync (host=%s mailbox=%s groups=%s)",
        host,
        mailbox,
        ", ".join(sorted(group_keys)),
    )

    backoff = 1
    while True:
        try:
            new_messages = poll_once(
                db_path=db_path,
                host=host,
                port=port,
                user=user,
                password=password,
                mailbox=mailbox,
                group_keys=group_keys,
            )
            if new_messages:
                saved = _save_messages(db_path, new_messages)
                if saved:
                    logger.info("Google Groups: %d new messages", saved)
                    publish_event(
                        "vibez.messages.synced",
                        f"google-groups-{int(time.time())}",
                        f"vibez:google-groups:{int(time.time())}",
                        {"count": saved, "groups": sorted(group_keys)},
                    )
                    if on_messages:
                        await on_messages(new_messages[:saved])
            backoff = 1
            await asyncio.sleep(poll_interval)
        except Exception:
            logger.exception("Google Groups sync error; retrying in %ds", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 300)
