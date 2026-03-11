# ABOUTME: Entry point for the wisdom extraction batch job.
# ABOUTME: Run daily or on-demand to extract collective knowledge from chat history.

"""Run the wisdom extraction pipeline."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.wisdom import run_wisdom_extraction


def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(description="Extract collective wisdom from chat history")
    parser.add_argument("db_path", help="Path to vibez.db")
    parser.add_argument("--api-key", help="Anthropic API key (or set ANTHROPIC_API_KEY)")
    parser.add_argument(
        "--model",
        default="claude-haiku-4-5-20251001",
        help="Model to use for classification and synthesis",
    )
    parser.add_argument(
        "--full-rebuild",
        action="store_true",
        help="Clear and rebuild all wisdom data",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("Error: set ANTHROPIC_API_KEY or pass --api-key")

    db_path = Path(args.db_path)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    result = run_wisdom_extraction(
        db_path=db_path,
        api_key=api_key,
        model=args.model,
        full_rebuild=args.full_rebuild,
    )

    print("\nWisdom extraction complete:")
    for key, value in result.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
