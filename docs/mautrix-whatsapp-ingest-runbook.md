# Mautrix WhatsApp Ingest Runbook

This runbook describes the Vibez replacement path for local Beeper Desktop ingestion. The first operating mode is dual-run: keep Beeper active while Matrix/mautrix ingestion runs in parallel and compare coverage before cutover.

## Target Railway Services

Create a separate Railway project or environment, for example `vibez-matrix-ingest`.

- `postgres`: Railway Postgres for Synapse and mautrix state.
- `synapse`: Matrix homeserver with a Railway volume for generated config, signing keys, media, uploads, and appservice registration files.
- `mautrix-whatsapp`: WhatsApp bridge service using the same Postgres instance and a private Railway URL for its appservice listener.
- `vibez-matrix-sync`: optional later service for hosted ingestion. For the pilot, local `backend/scripts/run_sync.py` can run Matrix sync against the Railway homeserver.

Keep this stack separate from the `dashboard` service. Synapse or mautrix restarts should not affect the public Vibez dashboard.

## Synapse And Mautrix Registration

mautrix-whatsapp runs as a Matrix application service. That means two files must agree:

- mautrix has a generated appservice registration file with placeholder tokens.
- Synapse includes that registration file in `app_service_config_files`.

On Railway, store generated config on the `synapse` volume, for example:

```text
/data/synapse/homeserver.yaml
/data/synapse/signing.key
/data/synapse/appservices/mautrix-whatsapp-registration.yaml
```

The service entrypoint should render or copy the mautrix registration file before Synapse starts. Do not commit the real registration file, homeserver signing key, bridge tokens, database URL, or WhatsApp session data.

## Required Runtime Values

Use Railway variables for these values. Values below are names only, not secrets.

Synapse:

```bash
SYNAPSE_SERVER_NAME=matrix-vibez.example.com
SYNAPSE_PUBLIC_BASEURL=https://matrix-vibez.example.com
SYNAPSE_REPORT_STATS=no
SYNAPSE_CONFIG_DIR=/data/synapse
SYNAPSE_DATA_DIR=/data/synapse
SYNAPSE_APPSERVICE_CONFIG=/data/synapse/appservices/mautrix-whatsapp-registration.yaml
DATABASE_URL=<railway-postgres-url>
```

mautrix-whatsapp:

```bash
MAUTRIX_HOMESERVER_ADDRESS=http://synapse.railway.internal:8008
MAUTRIX_HOMESERVER_DOMAIN=matrix-vibez.example.com
MAUTRIX_APPSERVICE_ADDRESS=http://mautrix-whatsapp.railway.internal:${PORT}
MAUTRIX_APPSERVICE_HOSTNAME=0.0.0.0
MAUTRIX_APPSERVICE_PORT=${PORT}
DATABASE_URL=<railway-postgres-url>
```

Vibez local dual-run:

```bash
MATRIX_SYNC_ENABLED=true
MATRIX_SOURCE_NAME=mautrix
MATRIX_HOMESERVER=https://matrix-vibez.example.com
MATRIX_ACCESS_TOKEN=<matrix-user-access-token>
```

## WhatsApp Login

Use the existing phone. A separate phone is not required.

1. Create or identify the Matrix user Vibez will sync as.
2. Log in with a Matrix client.
3. Start a direct message with `@whatsappbot:<server-name>`.
4. Run the bridge login command for QR or pairing-code login.
5. On the existing phone, open WhatsApp Linked Devices and link the bridge.
6. Confirm target WhatsApp groups appear as Matrix rooms.

The phone must still come online periodically. Treat the bridge as another WhatsApp linked device.

## Vibez Dual-Run

Keep the existing Beeper launchd jobs enabled at first.

Run local sync with Matrix enabled:

```bash
cd /Users/braydon/projects/personal/vibez-monitor
source .env
MATRIX_SYNC_ENABLED=true \
MATRIX_SOURCE_NAME=mautrix \
backend/.venv/bin/python backend/scripts/run_sync.py
```

Message IDs from this source are stored as:

```text
matrix:mautrix:<matrix-event-id>
```

The Matrix sync cursor is stored in `sync_state` as:

```text
matrix_next_batch:mautrix
```

This keeps mautrix state separate from Beeper API cursors and legacy Matrix cursors.

## Coverage Checks

Before cutover, compare Beeper and mautrix coverage for at least one week.

Useful checks:

```sql
SELECT room_name, COUNT(*), MIN(timestamp), MAX(timestamp)
FROM messages
WHERE id LIKE 'matrix:mautrix:%'
GROUP BY room_name
ORDER BY COUNT(*) DESC;
```

```sql
SELECT room_name, COUNT(*), MIN(timestamp), MAX(timestamp)
FROM messages
WHERE id LIKE 'beeper-%'
GROUP BY room_name
ORDER BY COUNT(*) DESC;
```

Cut over only when:

- all target WhatsApp groups appear in Matrix,
- recent messages arrive within the expected polling window,
- sender names are usable,
- link extraction and downstream dashboard views include mautrix messages,
- no duplicate storm appears from bridge restarts.

## Rollback

To return to Beeper-only ingestion:

```bash
MATRIX_SYNC_ENABLED=false
```

Then restart the local sync service or unload the Matrix-specific worker. Existing `matrix:mautrix:*` rows can remain in the database; they do not affect Beeper cursors.

## Cutover

After validation:

1. Stop Beeper Desktop dependency for ingestion.
2. Keep `MATRIX_SYNC_ENABLED=true`.
3. Keep `MATRIX_SOURCE_NAME=mautrix` stable forever, because it is part of message IDs and cursor keys.
4. Continue pushing local data to Railway with the existing `scripts/local_sync_to_railway.sh` flow unless `vibez-matrix-sync` is moved to Railway.
