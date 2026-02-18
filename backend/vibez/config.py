"""Configuration management. Reads from env vars and Beeper DB."""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path


def read_beeper_token(beeper_db_path: str | Path) -> str:
    """Read the Matrix access token from Beeper's local database."""
    conn = sqlite3.connect(str(beeper_db_path))
    cursor = conn.execute("SELECT token FROM account LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    if not row:
        raise ValueError(f"No account found in Beeper DB: {beeper_db_path}")
    return row[0]


@dataclass
class Config:
    anthropic_api_key: str
    db_path: Path
    matrix_homeserver: str = "https://matrix.beeper.com"
    matrix_access_token: str = ""
    beeper_db_path: Path = field(
        default_factory=lambda: Path.home()
        / "Library/Application Support/BeeperTexts/account.db"
    )
    sync_timeout_ms: int = 30000
    classifier_model: str = "claude-sonnet-4-6"
    synthesis_model: str = "claude-sonnet-4-6"
    synthesis_hour: int = 6
    log_dir: Path = field(
        default_factory=lambda: Path.home() / "Library/Logs/vibez-monitor"
    )

    @classmethod
    def from_env(cls) -> Config:
        """Load configuration from environment variables."""
        from dotenv import load_dotenv

        load_dotenv()

        db_path = Path(os.environ.get("VIBEZ_DB_PATH", "./vibez.db"))
        beeper_db = Path(
            os.environ.get(
                "BEEPER_DB_PATH",
                str(Path.home() / "Library/Application Support/BeeperTexts/account.db"),
            )
        )

        token = os.environ.get("MATRIX_ACCESS_TOKEN", "")
        if not token and beeper_db.exists():
            token = read_beeper_token(beeper_db)

        return cls(
            anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
            db_path=db_path,
            matrix_homeserver=os.environ.get(
                "MATRIX_HOMESERVER", "https://matrix.beeper.com"
            ),
            matrix_access_token=token,
            beeper_db_path=beeper_db,
            sync_timeout_ms=int(os.environ.get("SYNC_TIMEOUT_MS", "30000")),
            classifier_model=os.environ.get("CLASSIFIER_MODEL", "claude-sonnet-4-6"),
            synthesis_model=os.environ.get("SYNTHESIS_MODEL", "claude-sonnet-4-6"),
            synthesis_hour=int(os.environ.get("SYNTHESIS_HOUR", "6")),
            log_dir=Path(
                os.environ.get(
                    "LOG_DIR", str(Path.home() / "Library/Logs/vibez-monitor")
                )
            ),
        )
