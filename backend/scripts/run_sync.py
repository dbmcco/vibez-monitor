"""Entry point for the Matrix sync service."""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.matrix_sync import sync_loop


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
    logger.info("Starting vibez-monitor sync service")
    logger.info("Database: %s", config.db_path)

    # Import classifier lazily to avoid circular deps
    from vibez.classifier import classify_messages

    async def on_messages(messages):
        await classify_messages(config, messages)

    await sync_loop(config, on_messages=on_messages)


if __name__ == "__main__":
    asyncio.run(main())
