#!/usr/bin/env bash
set -euo pipefail

cd dashboard
exec npx next start --port "${PORT:-3000}" --hostname 0.0.0.0
