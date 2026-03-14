# ABOUTME: Budget guard for Anthropic API calls. Tracks token usage per day
# ABOUTME: and freezes API calls when the daily spend limit is exceeded.

from __future__ import annotations

import logging
import sqlite3
from datetime import date, timezone, datetime
from pathlib import Path

logger = logging.getLogger("vibez.budget_guard")

# Anthropic pricing per million tokens (as of 2026-03)
# https://docs.anthropic.com/en/docs/about-claude/models
_PRICING: dict[str, tuple[float, float]] = {
    # (input_per_1m, output_per_1m)
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5-20251001": (0.80, 4.00),
    "claude-opus-4-6": (15.00, 75.00),
}

_DEFAULT_INPUT = 3.00
_DEFAULT_OUTPUT = 15.00

BUDGET_SCHEMA = """
CREATE TABLE IF NOT EXISTS api_budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_date DATE NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_budget_date ON api_budget (call_date);
"""


def ensure_table(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.executescript(BUDGET_SCHEMA)
    conn.commit()
    conn.close()


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    inp_rate, out_rate = _PRICING.get(model, (_DEFAULT_INPUT, _DEFAULT_OUTPUT))
    return (input_tokens * inp_rate + output_tokens * out_rate) / 1_000_000


def record_usage(
    db_path: Path,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> float:
    cost = estimate_cost(model, input_tokens, output_tokens)
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO api_budget (call_date, model, input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?)",
        (date.today().isoformat(), model, input_tokens, output_tokens, cost),
    )
    conn.commit()
    conn.close()
    return cost


def daily_spend(db_path: Path, target_date: date | None = None) -> float:
    target = (target_date or date.today()).isoformat()
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM api_budget WHERE call_date = ?",
        (target,),
    ).fetchone()
    conn.close()
    return row[0]


def check_budget(db_path: Path, daily_limit_usd: float) -> tuple[bool, float]:
    """Returns (allowed, spend_so_far). allowed=False means budget exceeded."""
    ensure_table(db_path)
    spent = daily_spend(db_path)
    if spent >= daily_limit_usd:
        logger.warning(
            "BUDGET FROZEN: $%.2f spent today (limit $%.2f)",
            spent,
            daily_limit_usd,
        )
        return False, spent
    return True, spent
