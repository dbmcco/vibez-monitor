import json
from vibez.classifier import build_classify_prompt, parse_classification


def test_build_classify_prompt():
    message = {
        "sender_name": "Sam Schillace",
        "room_name": "The vibez (code code code)",
        "body": "check out this new amplifier feature for context management",
    }
    value_config = {
        "topics": ["agentic-architecture", "practical-tools"],
        "projects": ["Amplifier", "driftdriver"],
    }
    context_messages = [
        {"sender_name": "Harper", "body": "anyone tried the new claude model?"},
    ]
    prompt = build_classify_prompt(message, value_config, context_messages)
    assert "Sam Schillace" in prompt
    assert "amplifier" in prompt.lower()
    assert "The vibez (code code code)" in prompt
    assert "Harper" in prompt


def test_build_classify_prompt_with_custom_subject():
    message = {
        "sender_name": "Nia",
        "room_name": "Builders",
        "body": "Can someone sanity check this architecture?",
    }
    value_config = {
        "topics": ["systems"],
        "projects": ["Beacon"],
    }
    prompt = build_classify_prompt(
        message,
        value_config,
        context_messages=None,
        subject_name="Alex",
    )
    assert "Alex's interest topics" in prompt
    assert "Alex could add value" in prompt
    assert "Braydon" not in prompt


def test_parse_classification_valid():
    raw = json.dumps({
        "relevance_score": 9,
        "topics": ["agentic-arch", "context-management"],
        "entities": ["amplifier"],
        "contribution_flag": True,
        "contribution_hint": "Your driftdriver work relates to this",
        "alert_level": "hot",
    })
    result = parse_classification(raw)
    assert result["relevance_score"] == 9
    assert result["contribution_flag"] is True
    assert result["alert_level"] == "hot"


def test_parse_classification_clamps_score():
    raw = json.dumps({
        "relevance_score": 15,
        "topics": [],
        "entities": [],
        "contribution_flag": False,
        "contribution_hint": "",
        "alert_level": "none",
    })
    result = parse_classification(raw)
    assert result["relevance_score"] == 10


def test_parse_classification_invalid_json():
    result = parse_classification("not json at all")
    assert result["relevance_score"] == 0
    assert result["alert_level"] == "none"


def test_parse_classification_with_markdown_fences():
    raw = '```json\n{"relevance_score": 7, "topics": ["tools"], "entities": [], "contribution_flag": false, "contribution_hint": "", "alert_level": "digest"}\n```'
    result = parse_classification(raw)
    assert result["relevance_score"] == 7
    assert result["alert_level"] == "digest"
