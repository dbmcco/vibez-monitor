import os
import sqlite3
from unittest.mock import patch
from vibez.config import Config, read_beeper_token


def test_config_loads_from_env(tmp_path):
    env = {
        "ANTHROPIC_API_KEY": "sk-test-key",
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
        "MATRIX_HOMESERVER": "https://matrix.beeper.com",
        "BEEPER_DB_PATH": str(tmp_path / "nonexistent.db"),
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = Config.from_env()
    assert cfg.anthropic_api_key == "sk-test-key"
    assert cfg.matrix_homeserver == "https://matrix.beeper.com"


def test_config_defaults(tmp_path):
    env = {
        "ANTHROPIC_API_KEY": "sk-test-key",
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
        "BEEPER_DB_PATH": str(tmp_path / "nonexistent.db"),
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = Config.from_env()
    assert cfg.matrix_homeserver == "https://matrix.beeper.com"
    assert cfg.sync_timeout_ms == 30000
    assert cfg.classifier_model == "claude-sonnet-4-6"
    assert cfg.synthesis_model == "claude-sonnet-4-6"
    assert cfg.subject_name == "User"
    assert cfg.self_aliases == ("User",)


def test_config_profile_overrides(tmp_path):
    env = {
        "ANTHROPIC_API_KEY": "sk-test-key",
        "VIBEZ_DB_PATH": str(tmp_path / "test.db"),
        "BEEPER_DB_PATH": str(tmp_path / "nonexistent.db"),
        "VIBEZ_SUBJECT_NAME": "Alex",
        "VIBEZ_SELF_ALIASES": "alex,a.smith",
        "VIBEZ_DOSSIER_PATH": str(tmp_path / "custom_dossier.json"),
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = Config.from_env()

    assert cfg.subject_name == "Alex"
    assert cfg.self_aliases == ("Alex", "a.smith")
    assert str(cfg.dossier_path).endswith("custom_dossier.json")


def test_read_beeper_token(tmp_path):
    mock_db = tmp_path / "account.db"
    conn = sqlite3.connect(str(mock_db))
    conn.execute(
        "CREATE TABLE account (user_id TEXT, device_id TEXT, access_token TEXT, homeserver TEXT)"
    )
    conn.execute(
        "INSERT INTO account VALUES ('user', 'dev', 'syt_test_token', 'https://matrix.beeper.com/')"
    )
    conn.commit()
    conn.close()

    token = read_beeper_token(mock_db)
    assert token == "syt_test_token"
