# ABOUTME: Backfill links table from existing daily_reports.
# ABOUTME: Reads the stats column (which stores extracted links) and upserts them chronologically.

"""Backfill links table from existing daily_reports."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.db import init_db, get_connection
from vibez.links import upsert_links


def backfill(db_path: Path) -> int:
    init_db(db_path)
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT report_date, briefing_json, stats FROM daily_reports ORDER BY report_date ASC"
    ).fetchall()
    conn.close()

    total = 0
    for report_date, briefing_json, stats_json in rows:
        links: list[dict] = []
        # stats column stores the top-level "links" array from synthesis
        if stats_json:
            try:
                stats_links = json.loads(stats_json)
                if isinstance(stats_links, list):
                    links.extend(stats_links)
            except json.JSONDecodeError:
                pass
        if links:
            total += upsert_links(db_path, links, report_date=report_date)

    return total


if __name__ == "__main__":
    db = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vibez.db")
    count = backfill(db)
    print(f"Backfilled {count} links from existing reports.")
