# vibez-monitor

AGI community briefing app for high-volume group chats.

It ingests Beeper Desktop messages, classifies relevance + contribution opportunities, generates a daily briefing, and serves an interactive dashboard with chat, briefing, contribution, and stats workflows.

Built for personal intelligence workflows, but structured so anyone can run it with their own profile, groups, and priorities.

## Live Screenshots (February 26, 2026)

| Chat Agent | Executive Briefing |
| --- | --- |
| ![Chat Agent](docs/screenshots/chat-agent.png) | ![Executive Briefing](docs/screenshots/daily-briefing.png) |

| Contribution Priorities | Stats + Trends |
| --- | --- |
| ![Contribution Priorities](docs/screenshots/contribution-priorities.png) | ![Stats and Trends](docs/screenshots/network-stats.png) |

| People Relationship Network | Settings |
| --- | --- |
| ![People Relationship Network](docs/screenshots/network-graph.png) | ![Settings](docs/screenshots/settings.png) |

## Why It Exists

- High-velocity communities produce too much signal for manual tracking.
- Important follow-ups get buried without explicit prioritization.
- Relationship context (who is central, who connects clusters, who to follow up with) is difficult to keep in working memory.
- Daily briefing quality improves when synthesis uses both lexical and semantic retrieval.

## Human Rationale (Why This Helps)

- Without a system like this, people either skim endlessly or disengage and miss high-value moments.
- The goal is not to read less for its own sake; it is to spend attention where it creates the most leverage.
- In practice, daily use shifts from reactive scrolling to intentional action.
- You get a short executive view of what changed and why it matters.
- You get concrete contribution moves instead of vague “stay engaged” pressure.
- You can ask focused chat questions and get grounded answers from your own history.
- You can see who is central in the network and where relationship effort is likely to compound.
- Over time, this creates continuity: fewer dropped threads, better follow-through, and clearer signal on what to do next.

## What It Does

- Ingests decrypted message metadata/content from Beeper Desktop API (`http://localhost:23373`)
- Stores normalized messages and classifications in local SQLite (`vibez.db`)
- Optionally mirrors message embeddings to Postgres + pgvector for hybrid semantic retrieval
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
  - `Stats` trends, coverage, network views, and semantic arc clustering/drift checks
  - semantic boosts for Chat retrieval, Radar arc evidence, and Contribute opportunity density when pgvector is enabled

## Feature Highlights

- Chat agent over your local message corpus with source-grounded answers.
- Executive briefing with snapshot, daily memo, evidence, and radar arcs.
- Contribution opportunity model balancing urgency, need, leverage, aging risk, and blockers.
- Stats and trends with lifecycle analysis, co-occurrence, drilldowns, and people network graphing.
- Interactive people network with zoom/pan, filtering, and method transparency for relationship inference.
- Optional pgvector hybrid retrieval for semantic arcs, drift checks, and stronger evidence recall.

## Architecture At A Glance

1. `run_sync.py` ingests Beeper desktop API data and normalizes messages into SQLite.
2. Classification enriches messages with relevance, topics, needs, and contribution signals.
3. Optional pgvector indexing mirrors embeddings for semantic retrieval and clustering.
4. `run_synthesis.py` generates daily briefing artifacts and chat context resources.
5. Next.js API routes read SQLite/pgvector-backed analytics and expose dashboard endpoints.
6. Dashboard UI provides Chat, Briefing, Contribute, Stats, and Settings workflows.

## Data and Privacy Model

- Everything runs locally by default.
- Beeper API access is local desktop-only and reflects what your current client can decrypt/render.
- `.env`, `vibez.db`, generated logs, and local artifacts should stay out of git.
- This repo is source-public friendly; runtime data remains user-private.

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

## Optional: pgvector Hybrid Retrieval

Enable this when you want semantic retrieval for chat questions and briefing-arc evidence.

1. Set these in `.env`:

```bash
VIBEZ_PGVECTOR_URL=postgresql://user:pass@localhost:5432/vibez
VIBEZ_PGVECTOR_TABLE=vibez_message_embeddings
VIBEZ_PGVECTOR_DIM=256
VIBEZ_PGVECTOR_INDEX_ON_SYNC=true
```

2. Backfill existing SQLite history into pgvector:

```bash
backend/.venv/bin/python backend/scripts/pgvector_index.py --lookback-days 180
```

3. Keep embeddings current:

- `backend/scripts/run_sync.py` now auto-indexes newly synced/classified rows when `VIBEZ_PGVECTOR_URL` is set.

Where pgvector materially improves output:

- Chat: better recall for concept-similar questions when exact keywords differ.
- Briefing: stronger arc detection, semantic evidence clustering, and drift risk checks.
- Contribute: improved opportunity density around semantically related contribution patterns.
- Stats: semantic coverage/orphan monitoring and arc trend diagnostics.

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
