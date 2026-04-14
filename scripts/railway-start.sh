#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${VIBEZ_DB_PATH:-/data/vibez.db}"
SYNC_LOOP_ENABLED="${VIBEZ_SYNC_LOOP_ENABLED:-true}"
SYNC_LOOP_INTERVAL_SECONDS="${VIBEZ_SYNC_LOOP_INTERVAL_SECONDS:-43200}"

python3 - <<PY
from pathlib import Path
from vibez.db import init_db
init_db(Path("${DB_PATH}"))
print("Initialized sqlite database at ${DB_PATH}")
PY

if [[ "${SYNC_LOOP_ENABLED,,}" == "1" || "${SYNC_LOOP_ENABLED,,}" == "true" || "${SYNC_LOOP_ENABLED,,}" == "yes" || "${SYNC_LOOP_ENABLED,,}" == "on" ]]; then
  (
    while true; do
      python3 backend/scripts/run_sync_once.py || true
      python3 backend/scripts/refresh_message_links.py --db "${DB_PATH}" || true
      python3 backend/scripts/enrich_link_authors.py --limit 200 || true
      python3 backend/scripts/run_wisdom.py "${DB_PATH}" || true
      sleep "${SYNC_LOOP_INTERVAL_SECONDS}"
    done
  ) &
fi

cd dashboard
exec npx next start --port "${PORT:-3000}" --hostname 0.0.0.0
