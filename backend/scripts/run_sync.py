"""Entry point for the Beeper Desktop API sync service."""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.beeper_sync import sync_loop
from vibez.google_groups_sync import (
    canonical_group_key,
    sync_loop as google_groups_sync_loop,
)


async def main():
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)
    allowed_groups = {name for name in config.allowed_groups if name}
    allowed_groups_normalized = {name.strip().casefold() for name in allowed_groups}

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "sync.log"),
        ],
    )

    logger = logging.getLogger("vibez.sync")
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

    logger.info("Starting vibez-monitor sync service")
    logger.info("Database: %s", config.db_path)
    if beeper_enabled:
        logger.info("Beeper API: %s (poll=%ds)", config.beeper_api_url, config.poll_interval)
    else:
        logger.info("Beeper sync disabled (BEEPER_API_TOKEN missing)")
    if google_enabled:
        logger.info(
            "Google Groups IMAP: %s:%d mailbox=%s (poll=%ds) groups=%s bootstrap_days=%d bootstrap_cap=%d",
            config.google_groups_imap_host,
            config.google_groups_imap_port,
            config.google_groups_imap_mailbox,
            config.google_groups_poll_interval,
            ", ".join(sorted(google_groups)),
            config.google_groups_bootstrap_days,
            config.google_groups_bootstrap_max_uids,
        )
    elif config.google_groups_list_ids:
        logger.warning(
            "Google Groups list ids set but IMAP credentials missing; source disabled."
        )
    if config.pgvector_url:
        logger.info(
            "pgvector indexing enabled (table=%s, dim=%d)",
            config.pgvector_table,
            config.pgvector_dimensions,
        )

    # Classify new messages inline as they arrive
    from vibez.classifier import classify_messages
    from vibez.semantic_index import index_sqlite_links, index_sqlite_messages

    async def on_messages(messages):
        await classify_messages(config, messages)
        if not (config.pgvector_url and config.pgvector_index_on_sync):
            return
        message_ids = [
            str(msg.get("id"))
            for msg in messages
            if isinstance(msg, dict) and msg.get("id")
        ]
        if not message_ids:
            return
        try:
            indexed = index_sqlite_messages(
                config.db_path,
                config.pgvector_url,
                table=config.pgvector_table,
                dimensions=config.pgvector_dimensions,
                message_ids=message_ids,
            )
            if indexed:
                logger.info("Indexed %d messages into pgvector", indexed)
        except Exception:
            logger.exception("Failed to index sync batch into pgvector")
        try:
            indexed_links = index_sqlite_links(
                config.db_path,
                config.pgvector_url,
                table=config.pgvector_link_table,
                dimensions=config.pgvector_dimensions,
                source_messages=messages,
            )
            if indexed_links:
                logger.info("Indexed %d links into pgvector", indexed_links)
        except Exception:
            logger.exception("Failed to index link batch into pgvector")

    async def run_source_with_restart(name: str, source_coro_factory):
        while True:
            try:
                await source_coro_factory()
            except Exception:
                logger.exception("%s source crashed; restarting in 10s", name)
                await asyncio.sleep(10)

    tasks: list[asyncio.Task] = []
    if beeper_enabled:
        tasks.append(
            asyncio.create_task(
                run_source_with_restart(
                    "Beeper",
                    lambda: sync_loop(
                        db_path=config.db_path,
                        api_base=config.beeper_api_url,
                        api_token=config.beeper_api_token,
                        poll_interval=config.poll_interval,
                        on_messages=on_messages,
                    ),
                )
            )
        )
    if google_enabled:
        tasks.append(
            asyncio.create_task(
                run_source_with_restart(
                    "Google Groups",
                    lambda: google_groups_sync_loop(
                        db_path=config.db_path,
                        host=config.google_groups_imap_host,
                        port=config.google_groups_imap_port,
                        user=config.google_groups_imap_user,
                        password=config.google_groups_imap_password,
                        mailbox=config.google_groups_imap_mailbox,
                        group_keys=google_groups,
                        poll_interval=config.google_groups_poll_interval,
                        bootstrap_days=config.google_groups_bootstrap_days,
                        bootstrap_max_uids=config.google_groups_bootstrap_max_uids,
                        on_messages=on_messages,
                    ),
                )
            )
        )

    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
