"""Classify backfilled messages using local Ollama for speed and cost."""

import asyncio
import argparse
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.db import get_connection, init_db
from vibez.classifier import (
    build_classify_prompt,
    parse_classification,
    save_classification,
    load_value_config,
    write_hot_alert,
    CLASSIFY_SYSTEM,
)

OLLAMA_URL = "http://localhost:11434/api/chat"
DEFAULT_MODEL = "qwen2.5:3b"  # faster than qwen3:8b (no thinking overhead)
DEFAULT_CONCURRENCY = 2  # light parallelism — Ollama can queue a small batch


async def classify_one(
    client: httpx.AsyncClient,
    msg: dict,
    value_cfg: dict,
    db_path: Path,
    semaphore: asyncio.Semaphore,
    model: str,
) -> bool:
    """Classify a single message via Ollama. Returns True on success."""
    async with semaphore:
        prompt = build_classify_prompt(msg, value_cfg, None)
        try:
            resp = await client.post(
                OLLAMA_URL,
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": CLASSIFY_SYSTEM},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": 300},
                    "format": "json",
                },
                timeout=120.0,
            )
            resp.raise_for_status()
            data = resp.json()
            raw_text = data.get("message", {}).get("content", "")
            classification = parse_classification(raw_text)
            save_classification(db_path, msg["id"], classification)

            if classification["alert_level"] == "hot":
                write_hot_alert(db_path, msg, classification)

            return True
        except Exception as e:
            print(f"  Error classifying {msg['id']}: {e}", flush=True)
            return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill message classifications via Ollama.")
    parser.add_argument("--db-path", default="./vibez.db", help="Path to SQLite DB")
    parser.add_argument("--start-date", help="Inclusive YYYY-MM-DD lower bound on message date")
    parser.add_argument("--end-date", help="Inclusive YYYY-MM-DD upper bound on message date")
    parser.add_argument("--limit", type=int, help="Max messages to process")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ollama model name")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="Parallel requests")
    return parser.parse_args()


async def main():
    args = parse_args()
    db_path = Path(args.db_path)
    init_db(db_path)

    conn = get_connection(db_path)
    query = """SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name,
                      m.body, m.timestamp, m.raw_event
               FROM messages m
               LEFT JOIN classifications c ON m.id = c.message_id
               WHERE c.message_id IS NULL"""
    params: list[object] = []
    if args.start_date:
        query += " AND date(m.timestamp/1000,'unixepoch') >= ?"
        params.append(args.start_date)
    if args.end_date:
        query += " AND date(m.timestamp/1000,'unixepoch') <= ?"
        params.append(args.end_date)
    query += " ORDER BY m.timestamp ASC"
    if args.limit and args.limit > 0:
        query += " LIMIT ?"
        params.append(args.limit)

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    messages = [
        {
            "id": r[0], "room_id": r[1], "room_name": r[2], "sender_id": r[3],
            "sender_name": r[4], "body": r[5], "timestamp": r[6], "raw_event": r[7],
        }
        for r in rows
    ]

    total = len(messages)
    print(f"{total} unclassified messages", flush=True)
    if total == 0:
        print("Nothing to classify.")
        return

    value_cfg = load_value_config(db_path)
    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    start = time.time()
    done = 0

    print(
        f"Model={args.model} Concurrency={max(1, args.concurrency)} "
        f"Date range={args.start_date or 'min'}..{args.end_date or 'max'}",
        flush=True,
    )

    async with httpx.AsyncClient() as client:
        # Process in chunks to report progress
        chunk_size = 25
        for i in range(0, total, chunk_size):
            chunk = messages[i : i + chunk_size]
            tasks = [
                classify_one(client, msg, value_cfg, db_path, semaphore, args.model)
                for msg in chunk
            ]
            results = await asyncio.gather(*tasks)
            done += sum(results)
            elapsed = time.time() - start
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total - (i + len(chunk))) / rate if rate > 0 else 0
            print(
                f"  {i + len(chunk)}/{total} processed, {done} ok "
                f"({rate:.1f}/s, ETA {eta/60:.0f}m)",
                flush=True,
            )

    elapsed = time.time() - start
    print(f"\nDone! {done}/{total} classified in {elapsed:.0f}s ({done/elapsed:.1f}/s)")


if __name__ == "__main__":
    asyncio.run(main())
