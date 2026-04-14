# ABOUTME: Incremental message-to-links refresh for vibez SQLite.
# ABOUTME: Rebuilds or advances the links table from message bodies using a timestamp watermark.

"""Refresh the links table from messages."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.beeper_sync import load_allowed_groups
from vibez.config import Config
from vibez.db import init_db
from vibez.links import refresh_message_links


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh links from chat messages.")
    parser.add_argument("--db", default=None, help="Path to vibez.db (default: from env)")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Messages per upsert batch (default: 500)",
    )
    parser.add_argument(
        "--full-rebuild",
        action="store_true",
        help="Clear links and rebuild from current messages",
    )
    args = parser.parse_args()

    config = Config.from_env()
    db_path = Path(args.db) if args.db else config.db_path
    init_db(db_path)

    result = refresh_message_links(
        db_path=db_path,
        allowed_groups=load_allowed_groups(),
        full_rebuild=args.full_rebuild,
        batch_size=args.batch_size,
    )

    print(
        f"Links refresh complete: scanned={result['messages_scanned']} "
        f"new_links={result['links_inserted']} latest_timestamp={result['latest_timestamp']}"
    )


if __name__ == "__main__":
    main()
