# Mautrix WhatsApp Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working slice for self-hosted mautrix WhatsApp ingestion in Vibez.

**Architecture:** Generalize the existing Matrix sync module so it can ingest both Beeper Matrix and self-hosted mautrix WhatsApp portal rooms. Keep Beeper Desktop ingestion enabled by default and add Matrix ingestion behind an explicit env flag for dual-run validation.

**Tech Stack:** Python 3.12, httpx Matrix Client-Server API, pytest, Railway, Synapse, mautrix-whatsapp.

---

## File Structure

- Modify `backend/vibez/matrix_sync.py`: generic Matrix WhatsApp parser, source-scoped IDs, room detection, cursor helpers, sync loop parameters.
- Modify `backend/vibez/config.py`: Matrix sync enable/source env configuration.
- Modify `backend/scripts/run_sync.py`: optional Matrix source task alongside Beeper and Google Groups.
- Modify `backend/tests/test_matrix_sync.py`: red-green coverage for mautrix and compatibility behavior.
- Create `docs/mautrix-whatsapp-ingest-runbook.md`: Railway setup and operational runbook.

## Task 1: Matrix Parser And Cursor Semantics

**Files:**
- Modify: `backend/vibez/matrix_sync.py`
- Modify: `backend/tests/test_matrix_sync.py`

- [ ] **Step 1: Write failing tests for mautrix room detection and message normalization**

Add tests that expect:

```python
def test_filter_whatsapp_rooms_detects_mautrix_bridge_info():
    rooms_state = {
        "!wa:matrix.vibez": {
            "state": {"events": [
                {"type": "m.bridge", "content": {"bridgebot": "@whatsappbot:matrix.vibez", "protocol": {"id": "whatsapp"}}},
                {"type": "m.room.name", "content": {"name": "AGI Builders"}},
            ]}
        }
    }
    assert filter_whatsapp_rooms(rooms_state) == {"!wa:matrix.vibez": "AGI Builders"}
```

and:

```python
def test_parse_mautrix_message_uses_source_prefix_and_mxid_sender():
    event = {
        "event_id": "$ev1",
        "sender": "@whatsapp_15551234567:matrix.vibez",
        "type": "m.room.message",
        "origin_server_ts": 1770000000000,
        "content": {"msgtype": "m.text", "body": "hello"},
    }
    msg = parse_message_event(event, "!wa:matrix.vibez", "AGI Builders", source_name="mautrix")
    assert msg["id"] == "matrix:mautrix:$ev1"
    assert msg["sender_name"] == "+15551234567"
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd backend && pytest tests/test_matrix_sync.py -q
```

Expected: FAIL because `filter_whatsapp_rooms` only recognizes Beeper bridge metadata and `parse_message_event` does not accept `source_name`.

- [ ] **Step 3: Implement minimal parser changes**

Update `parse_message_event`, `filter_whatsapp_rooms`, and extraction callers to accept `source_name`, detect mautrix bridge metadata, and source-prefix event IDs.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
cd backend && pytest tests/test_matrix_sync.py -q
```

Expected: PASS.

## Task 2: Matrix Source Configuration And Runtime Wiring

**Files:**
- Modify: `backend/vibez/config.py`
- Modify: `backend/scripts/run_sync.py`
- Modify: `backend/tests/test_config.py`

- [ ] **Step 1: Write failing config/runtime tests**

Add config tests for:

```python
def test_matrix_sync_enabled_env(monkeypatch):
    monkeypatch.setenv("MATRIX_SYNC_ENABLED", "true")
    monkeypatch.setenv("MATRIX_SOURCE_NAME", "mautrix")
    config = Config.from_env()
    assert config.matrix_sync_enabled is True
    assert config.matrix_source_name == "mautrix"
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run:

```bash
cd backend && pytest tests/test_config.py -q
```

Expected: FAIL because `matrix_sync_enabled` and `matrix_source_name` do not exist.

- [ ] **Step 3: Add config fields and run_sync source task**

Add `matrix_sync_enabled: bool = False` and `matrix_source_name: str = "matrix"` to `Config`, parse them from env, and start `vibez.matrix_sync.sync_loop(config, on_messages=on_messages)` from `run_sync.py` when enabled.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cd backend && pytest tests/test_config.py tests/test_matrix_sync.py -q
```

Expected: PASS.

## Task 3: Operational Runbook

**Files:**
- Create: `docs/mautrix-whatsapp-ingest-runbook.md`

- [ ] **Step 1: Write the runbook**

Document:

- Railway service layout.
- Required secrets and generated files.
- Synapse appservice registration relationship.
- WhatsApp login flow using the existing phone.
- Vibez env vars for dual-run.
- Coverage checks before cutover.
- Rollback path back to Beeper-only ingestion.

- [ ] **Step 2: Review for secret leakage**

Run:

```bash
rg -n "access_token|as_token|hs_token|password|secret|BEGIN|PRIVATE" docs/mautrix-whatsapp-ingest-runbook.md
```

Expected: only placeholder language, no real secrets.

## Task 4: Final Verification And Speedrift Closeout

**Files:**
- No new files beyond previous tasks.

- [ ] **Step 1: Run backend targeted tests**

Run:

```bash
cd backend && pytest tests/test_matrix_sync.py tests/test_config.py -q
```

Expected: PASS.

- [ ] **Step 2: Run drift check**

Run:

```bash
./.workgraph/drifts check --task mautrix-whatsapp-ingest-pilot --write-log --create-followups
```

Expected: no blocking drift. Advisory findings should be logged or converted into follow-ups.

- [ ] **Step 3: Update Workgraph**

Run:

```bash
wg log mautrix-whatsapp-ingest-pilot "Implemented mautrix Matrix ingest pilot slice: parser/config/runtime wiring/runbook; targeted tests pass."
wg done mautrix-whatsapp-ingest-pilot
```

Expected: task marked done after verification.
