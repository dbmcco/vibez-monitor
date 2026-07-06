# Mautrix WhatsApp Ingest Design

## Goal

Replace the fragile local Beeper Desktop dependency with a self-hosted WhatsApp-to-Matrix bridge that Vibez can ingest from directly, while keeping Beeper active until the new source proves equivalent in dual-run.

## Recommended Architecture

Run the bridge stack separately from the Vibez dashboard. The Railway topology is:

- `postgres`: persistent Railway Postgres used by Synapse and mautrix, with separate databases or schemas.
- `synapse`: public Matrix homeserver, with a volume for generated config, signing keys, media, and registration files.
- `mautrix-whatsapp`: private Railway service that connects to Synapse over `railway.internal` and exposes its appservice listener only inside the project.
- `vibez-matrix-sync`: Vibez source worker that reads Matrix client `/sync` events and writes normalized records into the existing `messages` table.

The dashboard remains a separate serving surface. Bridge failures should not take down the hosted Vibez UI.

## Data Flow

1. User links their existing WhatsApp account to `mautrix-whatsapp` as a WhatsApp linked device.
2. `mautrix-whatsapp` creates Matrix portal rooms for WhatsApp groups and syncs message events into Synapse.
3. Vibez Matrix sync authenticates as a Matrix user and long-polls `/_matrix/client/v3/sync`.
4. Vibez filters WhatsApp portal rooms, parses `m.room.message` events, normalizes them to the existing message shape, and inserts them with stable source-prefixed IDs.
5. Existing classification, pgvector indexing, link extraction, push, briefing, and dashboard paths continue to consume the same `messages` rows.

## Vibez Integration

The existing `backend/vibez/matrix_sync.py` becomes a generic Matrix WhatsApp source instead of a Beeper-only sync path.

Required behavior:

- Preserve support for Beeper Matrix bridge metadata.
- Detect mautrix WhatsApp rooms from `m.bridge` events, room names, and mautrix ghost/bot naming conventions.
- Normalize sender names from Beeper metadata when present, Matrix display names when present, and `@whatsapp_*` ghost MXIDs when no display name is available.
- Prefix Matrix event IDs with source information to avoid collisions with Beeper API message IDs and between homeservers.
- Store Matrix sync cursors under source-specific keys, so Beeper Matrix and mautrix Matrix do not overwrite each other.
- Run behind `MATRIX_SYNC_ENABLED=true`, allowing Beeper Desktop API and Google Groups to continue unchanged.

## Deployment And Operations

Railway deployment is viable, but config generation is the hard part. Synapse must see the mautrix `registration.yaml` in `app_service_config_files`, and mautrix must know Synapse's internal URL and its own internal listener. A small custom entrypoint should render these files from Railway secrets and mounted volumes.

Initial pilot sequence:

1. Deploy Synapse and mautrix in a separate Railway project/environment.
2. Create a Matrix admin/user account for Vibez ingestion.
3. DM `@whatsappbot:<server>` and run `login qr` or pairing-code login.
4. Link from the existing WhatsApp phone under Linked Devices.
5. Start Vibez Matrix sync in dual-run while keeping Beeper Desktop ingestion active.
6. Compare per-room counts and recent message coverage for one week.
7. Make mautrix the primary source only after coverage matches expectations.

## Non-Goals

- No production cutover in the first slice.
- No replacement of Beeper until dual-run validation passes.
- No combined Synapse/mautrix/dashboard container.
- No committed secrets, access tokens, Matrix signing keys, or WhatsApp session state.

## Acceptance Criteria

- Matrix parser supports representative Beeper and mautrix WhatsApp events.
- Matrix source can be enabled independently from Beeper using env vars.
- Cursor and message IDs are source-scoped.
- Tests cover mautrix room detection, sender normalization, source-prefixed IDs, and existing Beeper compatibility.
- A runbook explains Railway setup, WhatsApp login, Vibez sync configuration, dual-run validation, and cutover.
