from pathlib import Path

from vibez.dossier import format_dossier_for_classifier, load_dossier
from vibez.profile import get_dossier_path, get_self_aliases, get_subject_name


def test_custom_subject_without_alias_override_drops_default_braydon_aliases(monkeypatch):
    monkeypatch.setenv("VIBEZ_SUBJECT_NAME", "Alex")
    monkeypatch.delenv("VIBEZ_SELF_ALIASES", raising=False)
    assert get_subject_name() == "Alex"
    assert get_self_aliases() == ("Alex",)


def test_custom_subject_alias_override_is_used(monkeypatch):
    monkeypatch.setenv("VIBEZ_SUBJECT_NAME", "Alex")
    monkeypatch.setenv("VIBEZ_SELF_ALIASES", "alex,a.smith")
    assert get_self_aliases() == ("Alex", "a.smith")


def test_missing_custom_dossier_path_returns_none(tmp_path):
    missing = tmp_path / "does-not-exist.json"
    assert load_dossier(missing) is None


def test_dossier_formatting_uses_subject_name():
    dossier = {
        "identity": {
            "expertise": "operating systems",
            "voice_summary": "short and concrete",
        },
        "summary": "shipping a new scheduler",
        "projects": [],
    }
    text = format_dossier_for_classifier(dossier, subject_name="Alex")
    assert "ALEX'S EXPERTISE" in text
    assert "Alex's unique perspective" in text
    assert "Braydon" not in text


def test_dossier_path_uses_env_override(monkeypatch, tmp_path):
    custom = tmp_path / "profile.json"
    monkeypatch.setenv("VIBEZ_DOSSIER_PATH", str(custom))
    assert get_dossier_path() == Path(str(custom))
