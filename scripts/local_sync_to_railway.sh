#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/backend/.venv/bin/python}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python venv not found at $PYTHON_BIN" >&2
  echo "Run: cd backend && python3 -m venv .venv && .venv/bin/pip install -e ." >&2
  exit 1
fi

export VIBEZ_DB_PATH="${VIBEZ_DB_PATH:-$ROOT_DIR/vibez.db}"
export VIBEZ_PGVECTOR_INDEX_ON_SYNC=false
export VIBEZ_SYNC_ONCE_RUN_SYNTHESIS=false
LOOKBACK_DAYS="${VIBEZ_PUSH_LOOKBACK_DAYS:-2}"
RUN_REMOTE_REFRESH=1
BACKFILL_YEAR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backfill-year)
      BACKFILL_YEAR=1
      shift
      ;;
    --lookback-days)
      LOOKBACK_DAYS="$2"
      shift 2
      ;;
    --skip-remote-refresh)
      RUN_REMOTE_REFRESH=0
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: ./scripts/local_sync_to_railway.sh [--backfill-year] [--lookback-days N] [--skip-remote-refresh]" >&2
      exit 1
      ;;
  esac
done

if [[ "$BACKFILL_YEAR" -eq 1 ]]; then
  if [[ -z "${BEEPER_API_TOKEN:-}" ]]; then
    echo "BEEPER_API_TOKEN is required for --backfill-year." >&2
    exit 1
  fi

  SINCE_DATE="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(days=365)).strftime("%Y-%m-%d"))
PY
)"

  echo "Running one-year Beeper API backfill since ${SINCE_DATE}..."
  "$PYTHON_BIN" backend/scripts/beeper_api_backfill.py \
    --since "$SINCE_DATE" \
    --db "$VIBEZ_DB_PATH"

  echo "Resetting local Google Groups cursor for one-year bootstrap..."
  "$PYTHON_BIN" - <<'PY'
import os
import sqlite3

db_path = os.environ["VIBEZ_DB_PATH"]
mailbox = os.environ.get("GOOGLE_GROUPS_IMAP_MAILBOX", "INBOX")
key = f"google_groups_uid_cursor:{mailbox}"
conn = sqlite3.connect(db_path)
conn.execute("DELETE FROM sync_state WHERE key = ?", (key,))
conn.commit()
conn.close()
print(f"Cleared local sync_state cursor: {key}")
PY

  export GOOGLE_GROUPS_BOOTSTRAP_DAYS="${GOOGLE_GROUPS_BOOTSTRAP_DAYS:-365}"
  export GOOGLE_GROUPS_BOOTSTRAP_MAX_UIDS="${GOOGLE_GROUPS_BOOTSTRAP_MAX_UIDS:-120000}"
  LOOKBACK_DAYS=370
fi

echo "Running local one-shot sync (Beeper + Google Groups)..."
"$PYTHON_BIN" backend/scripts/run_sync_once.py

echo "Pushing local data to Railway (lookback=${LOOKBACK_DAYS}d)..."
"$PYTHON_BIN" backend/scripts/push_remote.py \
  --lookback-days "$LOOKBACK_DAYS" \
  --batch-size "${VIBEZ_PUSH_BATCH_SIZE:-400}"

if [[ "$RUN_REMOTE_REFRESH" -eq 1 ]]; then
  RAILWAY_BIN="${RAILWAY_BIN:-$(command -v railway || true)}"
  if [[ -n "$RAILWAY_BIN" ]]; then
    REMOTE_INDEX_LOOKBACK="${VIBEZ_REMOTE_INDEX_LOOKBACK_DAYS:-$LOOKBACK_DAYS}"
    echo "Refreshing remote pgvector index (${REMOTE_INDEX_LOOKBACK}d)..."
    "$RAILWAY_BIN" ssh --service dashboard \
      "python backend/scripts/pgvector_index.py --lookback-days ${REMOTE_INDEX_LOOKBACK}"
    echo "Refreshing remote synthesis..."
    "$RAILWAY_BIN" ssh --service dashboard \
      "python backend/scripts/run_synthesis.py"
    echo "Enriching remote link authorship..."
    "$RAILWAY_BIN" ssh --service dashboard \
      "python backend/scripts/enrich_link_authors.py --limit 200"
  else
    echo "railway CLI not found; skipped remote pgvector/synthesis/author enrichment."
  fi
fi

echo "Local -> Railway sync complete."
