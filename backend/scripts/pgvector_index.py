"""Backfill or refresh pgvector embeddings from vibez SQLite data."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.semantic_index import index_sqlite_messages


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Index vibez messages into Postgres pgvector table."
    )
    parser.add_argument(
        "--db-path",
        type=Path,
        default=None,
        help="Path to vibez.db (defaults to config VIBEZ_DB_PATH)",
    )
    parser.add_argument(
        "--pg-url",
        default="",
        help="Postgres URL (defaults to VIBEZ_PGVECTOR_URL)",
    )
    parser.add_argument(
        "--table",
        default="",
        help="Target pgvector table name (defaults to VIBEZ_PGVECTOR_TABLE)",
    )
    parser.add_argument(
        "--dimensions",
        type=int,
        default=0,
        help="Embedding dimensions (defaults to VIBEZ_PGVECTOR_DIM)",
    )
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=0,
        help="Only index recent rows from this many days (0 = all rows)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit rows imported from SQLite (0 = no limit)",
    )
    args = parser.parse_args()

    config = Config.from_env()
    db_path = args.db_path or config.db_path
    pg_url = args.pg_url or config.pgvector_url
    table = args.table or config.pgvector_table
    dimensions = args.dimensions or config.pgvector_dimensions
    lookback = args.lookback_days if args.lookback_days > 0 else None
    limit = args.limit if args.limit > 0 else None

    if not pg_url:
        print(
            "Missing pgvector URL. Set VIBEZ_PGVECTOR_URL or pass --pg-url.",
            file=sys.stderr,
        )
        return 2

    indexed = index_sqlite_messages(
        db_path,
        pg_url,
        table=table,
        dimensions=dimensions,
        lookback_days=lookback,
        limit=limit,
    )
    print(
        f"Indexed {indexed} messages from {db_path} into {table} "
        f"(dim={dimensions})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
