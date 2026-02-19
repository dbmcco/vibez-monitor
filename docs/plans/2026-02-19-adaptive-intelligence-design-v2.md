# Vibez Monitor v2 — Adaptive Intelligence Layer (Revised)

## Goal

Transform vibez-monitor from a passive daily briefing tool into a strategic intelligence analyst that deeply understands who Braydon is (dossier), what he's building (project-pulse), and what the AGI community is discussing — then generates actionable contribution opportunities and opinionated research PoVs.

## Architecture

Two-app architecture:

1. **project-pulse** (new standalone): Automated project context service that scans git repos, reads workgraph states, and produces a structured JSON snapshot. Consumed by vibez-monitor and any future apps (paia-os, training-assistant, etc.).

2. **vibez-monitor** (revised): Drops Live Feed. Three focused pages: Briefing, Contribute, Analyst. Enriched by dossier + project-pulse. Feedback loop (dismiss/bookmark) tunes suggestions.

## Tech Stack

- project-pulse: Python, cron/launchd, JSON output to `~/.project-pulse/context.json`
- vibez-monitor backend: Python (existing), Anthropic API (Sonnet), Perplexity API (sonar-reasoning)
- vibez-monitor dashboard: Next.js (existing), minus Live Feed, plus Analyst page
- Data sources: dbm_dossier (`/Users/braydon/projects/personal/dbm_dossier`), project-pulse output

---

## App 1: project-pulse

### Purpose

Automated, zero-intervention project context service. Scans Braydon's repos and produces a structured JSON snapshot that any app can consume.

### Data Sources Per Repo

1. **Git activity**: `git log --since="7 days ago" --oneline --no-merges` + `git diff --stat HEAD~10..HEAD`
2. **Workgraph states**: Parse `.workgraph/graph.jsonl` if present — extract in-progress and blocked tasks with titles and descriptions
3. **Project identity**: Read `CLAUDE.md` or `README.md` first paragraph for what the project is
4. **Repo metadata**: Last commit date, total recent commits, primary language (from file extensions)

### Output Format

`~/.project-pulse/context.json`:
```json
{
  "generated_at": "2026-02-19T06:00:00Z",
  "scan_roots": ["/Users/braydon/projects/personal", "/Users/braydon/projects/experiments"],
  "projects": [
    {
      "name": "paia-os",
      "path": "/Users/braydon/projects/experiments/paia-os",
      "description": "Clean-room rebuild of assistant-system — hierarchy of intelligent agents with Paia as chief of staff",
      "recent_commits": 74,
      "last_commit": "2026-02-18",
      "commit_log": ["abc1234 feat: add self-reflection loop", "def5678 fix: agent handoff"],
      "diff_summary": "42 files changed, 1200 insertions, 300 deletions",
      "workgraph": {
        "total_tasks": 12,
        "in_progress": ["task-5: Agent memory persistence"],
        "blocked": ["task-8: Multi-agent coordination (blocked by task-5)"],
        "recently_done": ["task-4: Self-reflection engine"]
      },
      "activity_level": "high"
    }
  ],
  "summary": "Most active: paia-os (agent hierarchy rebuild), driftdriver (drift lane updates), training-assistant (briefing system). Shipping: agent self-reflection, drift contract validation, personalized learning paths."
}
```

### Summary Generation

After scanning all repos, call Haiku to generate the `summary` field — a 3-4 sentence narrative of what Braydon is actively building and shipping. This is the primary context string consumed by downstream apps.

### Scheduling

- launchd plist running every 4 hours (or on-demand via CLI)
- Fast scan: takes <10s for ~20 repos
- Summary generation: 1 Haiku call (~$0.001)

### Configuration

`~/.project-pulse/config.json`:
```json
{
  "scan_roots": [
    "/Users/braydon/projects/personal",
    "/Users/braydon/projects/experiments"
  ],
  "exclude_dirs": ["node_modules", ".venv", "__pycache__", ".git"],
  "exclude_repos": [],
  "lookback_days": 7,
  "output_path": "~/.project-pulse/context.json"
}
```

### Structure

```
project-pulse/
├── pyproject.toml
├── pulse/
│   ├── __init__.py
│   ├── scanner.py        # Git + workgraph + CLAUDE.md scanning
│   ├── summarizer.py     # Haiku summary generation
│   └── config.py         # Config loading
├── scripts/
│   └── run_pulse.py      # Entry point
├── tests/
│   ├── conftest.py
│   ├── test_scanner.py
│   └── test_summarizer.py
└── launchd/
    └── com.project-pulse.plist
```

---

## App 2: vibez-monitor (Revised)

### What Changes

**Removed:**
- `/` Live Feed page (drop entirely)
- `/api/messages` route (no longer needed as a page)
- Live Feed nav link

**Modified:**
- Classifier prompt: enriched with dossier expertise + project-pulse context + dismissed themes
- Synthesis prompt: enriched with dossier + project-pulse + dismissed themes
- Contribute page: dismiss/bookmark buttons, smarter suggestions
- Settings page: dismissed themes management, repos display (read from project-pulse)
- Nav: remove Live Feed, add Queue and Analyst

**Added:**
- `/queue` — Bookmark follow-up queue
- `/analyst` — Curiosity agent with Perplexity research + PoVs
- `/api/feedback` — Dismiss/bookmark CRUD
- `/api/bookmarks` — Queue management
- `/api/analyst` — Analyst reports
- `backend/vibez/analyst.py` — Question generation, Perplexity research, PoV synthesis
- `user_feedback` table — Dismiss/bookmark storage
- `analyst_reports` table — Analyst output storage

### Dossier Integration

The classifier and synthesis prompts get enriched with Braydon's dossier context:

**Into classifier prompt:**
```
BRAYDON'S EXPERTISE & CONTRIBUTION LENS:
- Cross-domain pattern connector (music theory → healthcare → AI → governance)
- Signature frames: "single-purpose application", "return on expense", "model-mediated systems"
- Recurring topics: AI governance, human-in-the-loop, economics/ROI, operating systems/task visibility, workflow design
- Decomposition approach: Define decision → outcome → constraints → system map → axis that matters → minimal path → governance → close
- Active projects: [from project-pulse summary]

When flagging contribution opportunities, match against these specific lenses —
not just topic keywords, but where Braydon's unique perspective adds value.
```

**Into synthesis prompt:**
```
BRAYDON'S PROFILE (for contribution matching):
- Career: Music Theory PhD → healthcare entrepreneur (Intempio) → AI-assisted development (LightForge)
- Expertise: governance/guardrails, workflow design, cross-domain pattern theft, economics-first thinking
- Current work: [project-pulse summary]
- Contribution style: questions-driven, concrete examples, governance framing, "what does it cost when it breaks?"

Match contributions to his SPECIFIC expertise, not generic "you could add value here."
```

### Feedback Loop (Dismiss/Learn)

Same as original design — `user_feedback` table, prompt injection of dismissed themes. No changes to this part.

### Analyst (Curiosity Agent)

Same as original design — question generation from synthesis, Perplexity research, PoV synthesis. But enriched:

**Question generation prompt gets:**
```
Braydon's lens: [dossier signature frames + decomposition loop]
Braydon's active work: [project-pulse summary]

Generate questions that Braydon's SPECIFIC background would find interesting —
not generic AI industry questions, but ones that connect to his governance focus,
cross-domain pattern recognition, or active projects.
```

### Dashboard Pages (Final)

| Page | Purpose |
|------|---------|
| `/briefing` | Daily intelligence briefing (home page, replaces Live Feed) |
| `/contribute` | Contribution opportunities with dismiss/bookmark |
| `/queue` | Bookmarked items for follow-up |
| `/analyst` | Agent's curiosity questions + research + PoVs |
| `/settings` | Topics, projects, dismissed themes |

### Daily Pipeline

```
project-pulse (separate, every 4h)
  └── ~/.project-pulse/context.json

run_synthesis.py (daily at 6am):
  1. Read project-pulse context.json
  2. Read dossier expertise summary (cached in value_config)
  3. Load dismissed themes from user_feedback
  4. Run daily synthesis (Sonnet) with enriched prompt
  5. Run analyst:
     a. Generate 3-5 curiosity questions (Sonnet, dossier-informed)
     b. Research each via Perplexity (sonar-reasoning)
     c. Synthesize PoVs (Sonnet)
  6. Save reports to DB
```

### API Cost Estimate (Daily)

| Call | Model | Cost |
|------|-------|------|
| project-pulse summary | Haiku | ~$0.001 |
| Synthesis | Sonnet | ~$0.04 |
| Analyst questions | Sonnet | ~$0.02 |
| Analyst PoV | Sonnet | ~$0.04 |
| Perplexity (3-5 queries) | sonar-reasoning | ~$0.05 |
| **Total daily** | | **~$0.15** |

---

## Build Order

1. **project-pulse** (standalone, ~1 hour)
   - Scanner module (git + workgraph + CLAUDE.md)
   - Summarizer (Haiku)
   - CLI entry point
   - launchd plist
   - Tests

2. **vibez-monitor schema + feedback** (~30 min)
   - user_feedback + analyst_reports tables
   - Feedback API
   - Dismiss/bookmark on ContributionCard

3. **vibez-monitor classifier/synthesis enrichment** (~30 min)
   - Load project-pulse context + dossier excerpts
   - Inject into classifier and synthesis prompts
   - Inject dismissed themes

4. **vibez-monitor analyst module** (~30 min)
   - Question generation with dossier lens
   - Perplexity research
   - PoV synthesis
   - Pipeline wiring

5. **vibez-monitor dashboard updates** (~30 min)
   - Drop Live Feed, make Briefing the home page
   - Queue page
   - Analyst page
   - Settings update
   - Nav update
