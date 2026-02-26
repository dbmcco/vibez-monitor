# vibez-monitor

AGI community briefing app for high-volume group chats.

It ingests Beeper Desktop messages, classifies relevance + contribution opportunities, generates a daily briefing, and serves an interactive dashboard with chat, briefing, contribution, and stats workflows.

## Live Screenshots (February 26, 2026)

| Chat Agent | Executive Briefing |
| --- | --- |
| ![Chat Agent](docs/screenshots/chat-agent.png) | ![Executive Briefing](docs/screenshots/daily-briefing.png) |

| Contribution Priorities | Stats + Trends |
| --- | --- |
| ![Contribution Priorities](docs/screenshots/contribution-priorities.png) | ![Stats and Trends](docs/screenshots/network-stats.png) |

## What It Does

- Ingests decrypted message metadata/content from Beeper Desktop API (`http://localhost:23373`)
- Stores normalized messages and classifications in local SQLite (`vibez.db`)
- Flags hot alerts and contribution opportunities
- Produces structured daily briefings with:
  - daily memo
  - conversation arcs
  - contribution actions + draft messages
  - trend shifts and references
- Exposes a dashboard at `http://localhost:3100` with:
  - `Chat` agent over your message corpus
  - `Briefing` executive pulse + evidence
  - `Contribute` prioritization model
  - `Stats` trends, coverage, and network views

## Repo Layout

- `backend/`: ingestion, classification, synthesis, profile logic, tests
- `dashboard/`: Next.js UI and API routes
- `launchd/`: macOS launch agent templates
- `docs/screenshots/`: README screenshot assets

## Quick Start

1. Create env file:

```bash
cp .env.example .env
```

2. Backend setup:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cd ..
```

3. Dashboard setup:

```bash
cd dashboard
npm install
cd ..
```

4. Run sync + synthesis manually:

```bash
backend/.venv/bin/python backend/scripts/run_sync.py
backend/.venv/bin/python backend/scripts/run_synthesis.py
```

5. Run dashboard:

```bash
cd dashboard
npm run dev
```

Then open `http://localhost:3100`.

## Profile Personalization

This repo is intentionally user-specific at runtime but user-agnostic in source.

Set these in `.env` for your own profile:

- `VIBEZ_SUBJECT_NAME`
- `VIBEZ_SELF_ALIASES`
- `VIBEZ_DOSSIER_PATH`
- `VIBEZ_EXCLUDED_GROUPS`

## launchd (macOS)

`launchd/*.plist` are templates.

Replace placeholders before loading:

- `__VIBEZ_ROOT__`
- `__LOG_DIR__`

See [launchd/README.md](launchd/README.md) for a complete setup command sequence.

## Testing

Backend:

```bash
backend/.venv/bin/python -m pytest backend/tests -q
```

Dashboard build:

```bash
cd dashboard
npm run build
```

## Notes

- Keep `.env`, `vibez.db`, logs, and local workflow artifacts out of git.
- Beeper Desktop API is local-only and reflects what your desktop client can decrypt/render.

## License

MIT (see [LICENSE](LICENSE)).
