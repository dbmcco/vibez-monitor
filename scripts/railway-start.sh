#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${VIBEZ_DB_PATH:-/data/vibez.db}"

python3 - <<PY
from pathlib import Path
from vibez.db import init_db
init_db(Path("${DB_PATH}"))
print("Initialized sqlite database at ${DB_PATH}")
PY

cd dashboard
exec npx next start --port "${PORT:-3000}" --hostname 0.0.0.0
