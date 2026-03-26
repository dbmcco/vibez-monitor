# ABOUTME: CLI script to enrich links with authorship data using LLM + URL heuristics.
# ABOUTME: Run periodically or on demand to classify whether links were authored by group members.

"""Enrich link authorship: classify which links were created vs just shared by group members."""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.author_classifier import enrich_link_authors
from vibez.config import Config
from vibez.db import init_db

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich links with authorship classification.")
    parser.add_argument("--db", default=None, help="Path to vibez.db (default: from env)")
    parser.add_argument("--limit", type=int, default=500, help="Max links to process (default: 500)")
    parser.add_argument("--model", default="claude-haiku-4-5-20251001", help="Claude model to use")
    parser.add_argument("--dry-run", action="store_true", help="Classify but don't write results")
    args = parser.parse_args()

    config = Config.from_env()
    db_path = Path(args.db) if args.db else config.db_path

    init_db(db_path)

    print(f"Processing up to {args.limit} unclassified links in {db_path} ...")
    counts = enrich_link_authors(
        db_path=db_path,
        api_key=config.anthropic_api_key,
        model=args.model,
        limit=args.limit,
        daily_budget_usd=config.daily_budget_usd,
        dry_run=args.dry_run,
    )

    print(
        f"Done. {counts['total']} links processed: "
        f"{counts['heuristic']} via heuristic, "
        f"{counts['llm']} via LLM, "
        f"{counts['skipped_budget']} skipped (budget)."
    )
    if args.dry_run:
        print("(dry-run: no changes written)")


if __name__ == "__main__":
    main()
