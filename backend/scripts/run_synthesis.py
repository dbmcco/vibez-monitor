"""Entry point for the daily synthesis agent."""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.synthesis import run_daily_synthesis


async def main():
    config = Config.from_env()
    config.log_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(config.log_dir / "synthesis.log"),
        ],
    )

    logger = logging.getLogger("vibez.synthesis")
    logger.info("Running daily synthesis")

    report = await run_daily_synthesis(config)
    logger.info("Done. Briefing threads: %d", len(report.get("briefing", [])))


if __name__ == "__main__":
    asyncio.run(main())
