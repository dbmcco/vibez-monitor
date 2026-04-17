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

from vibez.model_router import validate_route_requirements
from vibez.wisdom import run_wisdom_extraction


def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(description="Extract collective wisdom from chat history")
    parser.add_argument("db_path", help="Path to vibez.db")
    parser.add_argument(
        "--manifest-path",
        help="Path to model-routing.json (defaults to VIBEZ_MODEL_ROUTING_PATH or config/model-routing.json)",
    )
    parser.add_argument(
        "--full-rebuild",
        action="store_true",
        help="Clear and rebuild all wisdom data",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    db_path = Path(args.db_path)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    manifest_path = Path(
        args.manifest_path
        or os.environ.get("VIBEZ_MODEL_ROUTING_PATH", "config/model-routing.json")
    )
    validate_route_requirements(manifest_path)

    result = run_wisdom_extraction(
        db_path=db_path,
        full_rebuild=args.full_rebuild,
        manifest_path=manifest_path,
    )

    print("\nWisdom extraction complete:")
    for key, value in result.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
