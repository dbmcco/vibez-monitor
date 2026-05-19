#!/usr/bin/env bash
set -euo pipefail

cd dashboard
if [[ "${VIBEZ_ENRICH_WORKER_ENABLED:-0}" == "1" ]]; then
  node scripts/enrichment-worker.mjs &
fi
exec npx next start --port "${PORT:-3000}" --hostname 0.0.0.0
