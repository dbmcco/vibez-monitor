"""Backfill or refresh pgvector embeddings from vibez Postgres data."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.config import Config
from vibez.semantic_index import index_links, index_messages


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Index vibez messages into Postgres pgvector table."
    )
    parser.add_argument(
        "--pg-url",
        default="",
        help="Postgres URL (defaults to VIBEZ_DATABASE_URL)",
    )
    parser.add_argument(
        "--table",
        default="",
        help="Target pgvector table name (defaults to VIBEZ_PGVECTOR_TABLE)",
    )
    parser.add_argument(
        "--link-table",
        default="",
        help="Target link pgvector table name (defaults to VIBEZ_PGVECTOR_LINK_TABLE)",
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
        help="Limit rows imported from Postgres (0 = no limit)",
    )
    parser.add_argument(
        "--kind",
        choices=("messages", "links", "both"),
        default="both",
        help="Which embeddings to index (default: both)",
    )
    args = parser.parse_args()

    config = Config.from_env()
    pg_url = args.pg_url or config.database_url
    table = args.table or config.pgvector_table
    link_table = args.link_table or config.pgvector_link_table
    dimensions = args.dimensions or config.pgvector_dimensions
    lookback = args.lookback_days if args.lookback_days > 0 else None
    limit = args.limit if args.limit > 0 else None

    if not pg_url:
        print(
            "Missing database URL. Set VIBEZ_DATABASE_URL or pass --pg-url.",
            file=sys.stderr,
        )
        return 2

    indexed_messages = 0
    indexed_links = 0
    if args.kind in {"messages", "both"}:
        indexed_messages = index_messages(
            pg_url,
            table=table,
            dimensions=dimensions,
            lookback_days=lookback,
            limit=limit,
        )
    if args.kind in {"links", "both"}:
        indexed_links = index_links(
            pg_url,
            table=link_table,
            dimensions=dimensions,
            lookback_days=lookback,
            limit=limit,
        )
    print(
        f"Indexed {indexed_messages} messages into {table} and "
        f"{indexed_links} links into {link_table} (dim={dimensions})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
