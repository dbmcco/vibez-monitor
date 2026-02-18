"""Entry point for the Beeper Desktop API sync service."""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.beeper_sync import sync_loop


async def main():
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "sync.log"),
        ],
    )

    logger = logging.getLogger("vibez.sync")

    if not config.beeper_api_token:
        logger.error("BEEPER_API_TOKEN not set. Run OAuth flow or create token in Beeper Desktop > Settings > Developers.")
        sys.exit(1)

    logger.info("Starting vibez-monitor sync service (Beeper Desktop API)")
    logger.info("Database: %s", config.db_path)
    logger.info("API: %s", config.beeper_api_url)
    logger.info("Poll interval: %ds", config.poll_interval)

    # Classify new messages inline as they arrive
    from vibez.classifier import classify_messages

    async def on_messages(messages):
        await classify_messages(config, messages)

    await sync_loop(
        db_path=config.db_path,
        api_base=config.beeper_api_url,
        api_token=config.beeper_api_token,
        poll_interval=config.poll_interval,
        on_messages=on_messages,
    )


if __name__ == "__main__":
    asyncio.run(main())
