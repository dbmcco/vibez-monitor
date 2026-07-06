"""Regression tests for the Beeper API token resolution fix (commit 5106e15).

The July 2026 sync outage happened because ``beeper_api_token`` was read from a
static ``BEEPER_API_TOKEN`` env var that Beeper deactivates within ~24h. The fix
reads the live, no-expiry session token from Beeper's ``account.db`` instead
(the Desktop API at localhost:23373 accepts it), falling back to the env var
only when no local DB exists.

These tests guard against regressing back to the env-var-only behavior.
"""
import os
import sqlite3
from unittest.mock import patch

import pytest

from vibez.config import Config, read_beeper_token


def _make_account_db(path, token="syt_live_test_token_xyz"):
    """Create a minimal stand-in for Beeper's account.db (table `account`)."""
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE account (access_token TEXT)")
    conn.execute("INSERT INTO account (access_token) VALUES (?)", (token,))
    conn.commit()
    conn.close()


# --- the helper itself -------------------------------------------------------

def test_read_beeper_token_returns_access_token(tmp_path):
    db = tmp_path / "account.db"
    _make_account_db(db, "syt_a_specific_token_123")
    assert read_beeper_token(db) == "syt_a_specific_token_123"


def test_read_beeper_token_raises_when_no_account_row(tmp_path):
    db = tmp_path / "account.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE account (access_token TEXT)")  # table present, no rows
    conn.commit()
    conn.close()
    with pytest.raises(ValueError):
        read_beeper_token(db)


# --- Config.from_env() resolution (the outage fix) --------------------------

def test_config_resolves_beeper_api_token_from_db_not_env(tmp_path):
    """When account.db exists and holds a token, Config.from_env() must use it
    and IGNORE any BEEPER_API_TOKEN env var. This is the core outage fix."""
    db = tmp_path / "account.db"
    _make_account_db(db, "syt_live_from_db_token")
    env = {
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
        "BEEPER_DB_PATH": str(db),
        "BEEPER_API_TOKEN": "stale_env_token_that_must_be_ignored",
        "VIBEZ_OPENAI_API_KEY": "", "OPENAI_API_KEY": "",
        "VIBEZ_ANTHROPIC_API_KEY": "", "ANTHROPIC_API_KEY": "",
    }
    with patch.dict(os.environ, env, clear=True):
        cfg = Config.from_env()
    assert cfg.beeper_api_token == "syt_live_from_db_token", (
        "beeper_api_token must come from account.db, not the env var"
    )


def test_config_falls_back_to_env_when_no_db(tmp_path):
    """When no account.db exists (remote / non-Desktop deployments), the env-var
    fallback must still work so deployments without Beeper Desktop aren't broken."""
    env = {
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
        "BEEPER_DB_PATH": str(tmp_path / "nonexistent.db"),
        "BEEPER_API_TOKEN": "env_fallback_token",
        "VIBEZ_OPENAI_API_KEY": "", "OPENAI_API_KEY": "",
        "VIBEZ_ANTHROPIC_API_KEY": "", "ANTHROPIC_API_KEY": "",
    }
    with patch.dict(os.environ, env, clear=True):
        cfg = Config.from_env()
    assert cfg.beeper_api_token == "env_fallback_token"
