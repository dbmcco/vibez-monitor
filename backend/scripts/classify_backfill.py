"""Classify backfilled messages using local Ollama for speed and cost."""

import asyncio
import argparse
import fcntl
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
    load_value_config,
    write_hot_alert,
    CLASSIFY_SYSTEM,
)

OLLAMA_URL = "http://localhost:11434/api/chat"
DEFAULT_MODEL = "qwen2.5:3b"  # faster than qwen3:8b (no thinking overhead)
DEFAULT_CONCURRENCY = 2  # light parallelism — Ollama can queue a small batch
DEFAULT_NUM_PREDICT = 220
DEFAULT_CHUNK_SIZE = 100


async def classify_one(
    client: httpx.AsyncClient,
    msg: dict,
    value_cfg: dict,
    semaphore: asyncio.Semaphore,
    model: str,
    num_predict: int,
) -> tuple[dict, dict] | None:
    """Classify a single message via Ollama. Returns message+classification on success."""
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
                    "options": {"temperature": 0.1, "num_predict": num_predict},
                    "format": "json",
                },
                timeout=120.0,
            )
            resp.raise_for_status()
            data = resp.json()
            raw_text = data.get("message", {}).get("content", "")
            classification = parse_classification(raw_text)
            return msg, classification
        except Exception as e:
            print(f"  Error classifying {msg['id']}: {e}", flush=True)
            return None


def save_classifications_batch(db_path: Path, rows: list[tuple[dict, dict]]) -> None:
    """Persist a batch of classifications in one DB transaction."""
    if not rows:
        return
    conn = get_connection(db_path)
    conn.executemany(
        """INSERT OR REPLACE INTO classifications
           (message_id, relevance_score, topics, entities, contribution_flag, contribution_themes, contribution_hint, alert_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                msg["id"],
                classification["relevance_score"],
                json.dumps(classification["topics"]),
                json.dumps(classification["entities"]),
                classification["contribution_flag"],
                json.dumps(classification.get("contribution_themes", [])),
                classification["contribution_hint"],
                classification["alert_level"],
            )
            for msg, classification in rows
        ],
    )
    conn.commit()
    conn.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill message classifications via Ollama.")
    parser.add_argument("--db-path", default="./vibez.db", help="Path to SQLite DB")
    parser.add_argument("--start-date", help="Inclusive YYYY-MM-DD lower bound on message date")
    parser.add_argument("--end-date", help="Inclusive YYYY-MM-DD upper bound on message date")
    parser.add_argument("--limit", type=int, help="Max messages to process")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ollama model name")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="Parallel requests")
    parser.add_argument(
        "--num-predict",
        type=int,
        default=DEFAULT_NUM_PREDICT,
        help="Max tokens generated per classification response",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=DEFAULT_CHUNK_SIZE,
        help="Messages to schedule per progress chunk",
    )
    parser.add_argument(
        "--lock-file",
        help="Optional lock file path to avoid overlapping backfill workers",
    )
    return parser.parse_args()


async def main():
    args = parse_args()
    db_path = Path(args.db_path)
    init_db(db_path)
    lock_handle = None

    if args.lock_file:
        lock_path = Path(args.lock_file)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_handle = lock_path.open("w")
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print(f"Another classifier run is active (lock busy: {lock_path})")
            return

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
        f"num_predict={max(32, args.num_predict)} chunk_size={max(1, args.chunk_size)} "
        f"Date range={args.start_date or 'min'}..{args.end_date or 'max'}",
        flush=True,
    )

    async with httpx.AsyncClient() as client:
        # Process in chunks to report progress
        chunk_size = max(1, args.chunk_size)
        num_predict = max(32, args.num_predict)
        for i in range(0, total, chunk_size):
            chunk = messages[i : i + chunk_size]
            tasks = [
                classify_one(client, msg, value_cfg, semaphore, args.model, num_predict)
                for msg in chunk
            ]
            results = await asyncio.gather(*tasks)
            ok_rows = [r for r in results if r is not None]
            if ok_rows:
                save_classifications_batch(db_path, ok_rows)
                for msg, classification in ok_rows:
                    if classification["alert_level"] == "hot":
                        write_hot_alert(db_path, msg, classification)

            done += len(ok_rows)
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
