"""Entry point for one-shot sync + classify + pgvector indexing.

Use this for scheduled jobs (for example every 12 hours) when you do not
want a continuously running sync worker.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.beeper_sync import (  # noqa: E402
    api_get,
    check_token_health,
    get_whatsapp_groups,
    load_cursor,
    poll_once as beeper_poll_once,
    save_active_groups as save_beeper_active_groups,
    save_cursor,
)
from vibez.config import Config  # noqa: E402
from vibez.db import init_db  # noqa: E402
from vibez.google_groups_sync import (  # noqa: E402
    _save_active_groups as save_google_active_groups,
    _save_messages as save_google_messages,
    canonical_group_key,
    poll_once as google_poll_once,
)
from vibez.paia_events_adapter import publish_event  # noqa: E402


def env_enabled(name: str) -> bool:
    raw = os.environ.get(name, "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def initialize_beeper_cursors(config: Config, groups: list[dict]) -> None:
    """Initialize cursors for new groups to avoid backfilling old history."""
    for group in groups:
        group_id = str(group.get("id", "")).strip()
        if not group_id:
            continue
        if load_cursor(config.db_path, group_id) is not None:
            continue

        encoded = urllib.parse.quote(group_id, safe="")
        try:
            data = api_get(
                config.beeper_api_url,
                f"/v1/chats/{encoded}/messages",
                config.beeper_api_token,
            )
            items = data.get("items", [])
            if items:
                save_cursor(config.db_path, group_id, items[0]["sortKey"])
        except Exception:
            logging.getLogger("vibez.sync_once").warning(
                "Could not initialize cursor for group id=%s",
                group_id,
            )


async def classify_and_index(config: Config, messages: list[dict]) -> None:
    from vibez.classifier import classify_messages
    from vibez.semantic_index import index_sqlite_links, index_sqlite_messages

    await classify_messages(config, messages)

    if not (config.pgvector_url and config.pgvector_index_on_sync):
        return

    message_ids = [
        str(message.get("id"))
        for message in messages
        if isinstance(message, dict) and message.get("id")
    ]
    if not message_ids:
        return

    indexed = index_sqlite_messages(
        config.db_path,
        config.pgvector_url,
        table=config.pgvector_table,
        dimensions=config.pgvector_dimensions,
        message_ids=message_ids,
    )
    if indexed:
        logging.getLogger("vibez.sync_once").info(
            "Indexed %d messages into pgvector",
            indexed,
        )
    indexed_links = index_sqlite_links(
        config.db_path,
        config.pgvector_url,
        table=config.pgvector_link_table,
        dimensions=config.pgvector_dimensions,
        source_messages=messages,
    )
    if indexed_links:
        logging.getLogger("vibez.sync_once").info(
            "Indexed %d links into pgvector",
            indexed_links,
        )


async def main() -> None:
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)
    allowed_groups = {name for name in config.allowed_groups if name}
    allowed_groups_normalized = {name.strip().casefold() for name in allowed_groups}

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "sync-once.log"),
        ],
    )

    logger = logging.getLogger("vibez.sync_once")
    google_groups = {
        key
        for raw in config.google_groups_list_ids
        if (key := canonical_group_key(raw))
    }
    if allowed_groups_normalized:
        google_groups = {
            key for key in google_groups if key.strip().casefold() in allowed_groups_normalized
        }
    beeper_enabled = bool(config.beeper_api_token)
    google_enabled = bool(config.google_groups_enabled and google_groups)

    if not (beeper_enabled or google_enabled):
        logger.error(
            "No sync source configured. Set BEEPER_API_TOKEN and/or GOOGLE_GROUPS_* env vars."
        )
        sys.exit(1)

    init_db(config.db_path)
    logger.info("Running one-shot sync job")
    logger.info("Database: %s", config.db_path)

    all_new_messages: list[dict] = []

    if beeper_enabled:
        logger.info("Beeper one-shot sync: %s", config.beeper_api_url)
        check_token_health(config.beeper_api_url, config.beeper_api_token)
        groups = get_whatsapp_groups(config.beeper_api_url, config.beeper_api_token)
        logger.info("Beeper groups in scope: %d", len(groups))
        save_beeper_active_groups(config.db_path, groups)
        initialize_beeper_cursors(config, groups)
        beeper_messages = beeper_poll_once(
            config.db_path,
            config.beeper_api_url,
            config.beeper_api_token,
            groups,
        )
        logger.info("Beeper new messages: %d", len(beeper_messages))
        all_new_messages.extend(beeper_messages)
    else:
        logger.info("Beeper one-shot sync skipped (BEEPER_API_TOKEN missing)")

    if google_enabled:
        logger.info(
            "Google Groups one-shot sync: mailbox=%s groups=%s bootstrap_days=%d bootstrap_cap=%d",
            config.google_groups_imap_mailbox,
            ", ".join(sorted(google_groups)),
            config.google_groups_bootstrap_days,
            config.google_groups_bootstrap_max_uids,
        )
        save_google_active_groups(config.db_path, google_groups)
        parsed_messages = google_poll_once(
            db_path=config.db_path,
            host=config.google_groups_imap_host,
            port=config.google_groups_imap_port,
            user=config.google_groups_imap_user,
            password=config.google_groups_imap_password,
            mailbox=config.google_groups_imap_mailbox,
            group_keys=google_groups,
            bootstrap_days=config.google_groups_bootstrap_days,
            bootstrap_max_uids=config.google_groups_bootstrap_max_uids,
        )
        saved = save_google_messages(config.db_path, parsed_messages)
        if saved:
            publish_event(
                "vibez.messages.synced",
                f"google-groups-{int(time.time())}",
                f"vibez:google-groups:{int(time.time())}",
                {"count": saved, "groups": sorted(google_groups)},
            )
        logger.info("Google Groups new messages: %d", saved)
        all_new_messages.extend(parsed_messages[:saved])
    elif config.google_groups_list_ids:
        logger.warning(
            "Google Groups list ids set but IMAP credentials missing; source skipped."
        )

    if all_new_messages:
        await classify_and_index(config, all_new_messages)
        logger.info("Classified/indexed messages: %d", len(all_new_messages))
    else:
        logger.info("No new messages discovered in this run.")

    if env_enabled("VIBEZ_SYNC_ONCE_RUN_SYNTHESIS"):
        from vibez.synthesis import run_daily_synthesis

        report = await run_daily_synthesis(config)
        if isinstance(report, dict):
            report_date = report.get("report_date", "unknown")
        else:
            report_date = getattr(report, "report_date", "unknown")
        logger.info("Synthesis refreshed for date=%s", report_date)

    logger.info("One-shot sync job complete")


if __name__ == "__main__":
    asyncio.run(main())
