# Vibez Monitor v2 — Adaptive Intelligence Layer

## Goal

Transform vibez-monitor from a passive daily briefing tool into an adaptive intelligence system that learns from user feedback, knows what the user is actively building, and proactively researches questions the chat ecosystem raises.

## Architecture

Four interconnected features built on the existing SQLite + Next.js + Sonnet stack:

1. **Dismiss & Learn** — feedback loop that tunes classifier output
2. **Bookmark Queue** — action backlog for follow-up items
3. **Work Context** — git-based summarizer for active project awareness
4. **The Analyst** — autonomous curiosity agent with Perplexity research

All four feed into the existing classifier and synthesis pipeline — no new infrastructure, just new tables, modules, and UI pages.

## Tech Stack

- Backend: Python (existing vibez package), pp-cli (Perplexity), Haiku for cheap summarization
- Frontend: Next.js (existing dashboard), new pages + API routes
- Database: SQLite (new tables: user_feedback, bookmarks, analyst_reports)
- Research: pp-cli at /Users/<user>/projects/experiments/pp (Perplexity sonar-reasoning)

---

## Feature 1: Dismiss & Learn

### Data Model

New `user_feedback` table:
```sql
CREATE TABLE IF NOT EXISTS user_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,                    -- optional, links to messages.id
    theme TEXT NOT NULL,                -- contribution_theme that was dismissed/liked
    action TEXT NOT NULL,               -- 'dismiss' or 'bookmark'
    reason TEXT,                        -- optional free-text reason
    created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX idx_feedback_action ON user_feedback(action);
CREATE INDEX idx_feedback_theme ON user_feedback(theme);
```

### Classifier Integration

Before each classification call in `classifier.py`:
- Load last 50 dismissals from `user_feedback WHERE action='dismiss'`
- Aggregate by theme: count how many times each theme was dismissed
- Inject into classifier prompt as negative signal:

```
DISMISSED THEMES (the user finds these less relevant, down-weight):
  multi-agent-orchestration: dismissed 3 times
  productivity: dismissed 1 time
```

This is prompt-level preference learning — no fine-tuning required. The classifier naturally adjusts its scoring when it sees themes the user consistently dismisses.

### Synthesis Integration

Before daily synthesis in `synthesis.py`:
- Load dismissal patterns
- Add to synthesis prompt: "the user has dismissed these contribution themes recently: [list]. Deprioritize similar suggestions."

### Dashboard UI

On each ContributionCard and briefing contribution item:
- **Dismiss button** (X icon): Stores dismiss feedback for the card's theme. Card fades out. Optional reason popover.
- **Bookmark button** (bookmark icon): Stores bookmark feedback. Card gets bookmark indicator.

API routes:
- `POST /api/feedback` — `{ message_id, theme, action, reason? }`
- `GET /api/feedback?action=dismiss` — for settings page to show/manage dismissals

### Settings Integration

New section on `/settings` page: "Dismissed Themes" — shows themes you've dismissed with counts. Ability to un-dismiss (delete feedback).

---

## Feature 2: Bookmark Queue

### Data Model

Reuses `user_feedback` table where `action='bookmark'`. Additional status tracking:

```sql
ALTER TABLE user_feedback ADD COLUMN status TEXT DEFAULT 'active';
-- status: 'active' (needs follow-up) or 'done' (completed)
```

### Dashboard: /queue page

New page showing bookmarked items:
- Sorted by created_at DESC (newest first)
- Each item shows:
  - Original message context (room, sender, body preview)
  - Contribution hint from classifier
  - Theme badge
  - Freshness badge (based on original message timestamp)
  - "Done" button to mark as completed
  - "Open in chat" link (if feasible)
- Filter: active vs. done items
- Count badge on nav for active bookmarks

API routes:
- `GET /api/bookmarks?status=active` — list bookmarked items with message context
- `PUT /api/bookmarks/:id` — update status to 'done'

---

## Feature 3: Work Context (Git Summarizer)

### Module: `backend/vibez/work_context.py`

Scans a configurable list of local git repos and summarizes what the user is actively working on.

### Configuration

New value_config key `repos`:
```json
{
  "repos": [
    "/Users/<user>/projects/experiments/amplifier",
    "/Users/<user>/projects/experiments/driftdriver",
    "/Users/<user>/projects/experiments/workgraph",
    "/Users/<user>/projects/experiments/speedrift-ecosystem",
    "/Users/<user>/projects/personal/vibez-monitor",
    "/Users/<user>/projects/personal/moneycommand"
  ]
}
```

Editable via `/settings` page.

### Process

Runs daily before synthesis (or on-demand):

1. For each repo in config:
   - `git log --since="3 days ago" --oneline --no-merges` (subprocess)
   - `git diff --stat HEAD~5..HEAD` (what files changed)
2. Bundle all repo summaries into a single prompt
3. Call Haiku (cheap, fast): "Summarize what the user is actively building and shipping across these repos. Be specific about features, not just file names."
4. Store result in value_config as `work_context` (JSON string with timestamp)

### Classifier Integration

Inject work context into classifier prompt:
```
BRAYDON'S ACTIVE WORK (from git activity, last 3 days):
  - amplifier: Added OpenRouter provider module, fixed streaming in multi-round chat
  - workgraph: Implemented task dependency resolver, added contract validation
  - vibez-monitor: Built Beeper API sync, OAuth token refresh

Use this to identify specific contribution opportunities where his current work
directly relates to chat discussions.
```

### Synthesis Integration

Inject into synthesis prompt so contribution suggestions reference specific active work:
```
CURRENT PROJECTS (from git):
[work context summary]

When suggesting contributions, connect them to specific active work above.
```

### Staleness

Work context is regenerated daily. If a repo has no commits in 3 days, it's excluded from the active summary. Timestamp stored so we know when context was last refreshed.

---

## Feature 4: The Analyst (Curiosity Agent)

### Module: `backend/vibez/analyst.py`

Autonomous research agent that generates questions from chat activity, researches them via Perplexity, and forms opinionated points of view.

### Data Model

New `analyst_reports` table:
```sql
CREATE TABLE IF NOT EXISTS analyst_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,
    questions_json TEXT NOT NULL,       -- array of question objects
    research_json TEXT NOT NULL,        -- array of research results
    pov_json TEXT NOT NULL,             -- array of point-of-view objects
    pov_md TEXT NOT NULL,               -- rendered markdown
    generated_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX idx_analyst_date ON analyst_reports(report_date);
```

### Process (3 stages)

#### Stage 1: Question Generation

Input: Today's classified messages + trends from synthesis + work context
Model: Sonnet

Prompt:
```
You are an intelligence analyst monitoring 18 WhatsApp groups of AI/agentic experts.

Today's key threads: [from synthesis]
Emerging trends: [from synthesis]
the user's active work: [from work context]

What 3-5 questions does today's conversation make you genuinely curious about?

Look for:
- Gaps: What's nobody talking about that they should be?
- Contradictions: Where do people disagree and who's right?
- Unexplored angles: What's the second-order effect of what's being discussed?
- Connections: What threads connect to each other in ways nobody mentioned?
- Opportunities: What could the user build/share that nobody's asked for yet?

Return JSON:
[
  {
    "question": "Why is everyone building model routers but nobody discussing evaluation of router decisions?",
    "spark": "Thread X mentioned model routing, thread Y mentioned eval — but nobody connected them",
    "relevance_to_braydon": "Driftdriver already has eval hooks that could be generalized"
  }
]
```

#### Stage 2: Research

For each question:
1. Call `pp -r --no-interactive --output json "<question>"` (Perplexity sonar-reasoning)
2. Parse JSON response: answer + citations
3. Store raw research results

Implementation: Use subprocess to call pp CLI. Parse JSON stdout. Handle timeouts (30s per query).

#### Stage 3: PoV Synthesis

Input: Questions + research results + work context
Model: Sonnet

Prompt:
```
You researched these questions about the AI/agentic ecosystem.
Now form a point of view on each. Be opinionated. Be specific.

For each question:
- What did the research reveal?
- What's your take? (not neutral — pick a side)
- What should the user do about it? (specific action, not "keep an eye on it")
- Confidence level: high/medium/low (based on research quality)

[questions + research results]

Return JSON:
[
  {
    "question": "...",
    "research_summary": "2-3 sentences of key findings",
    "citations": ["url1", "url2"],
    "pov": "Opinionated 2-3 sentence take",
    "action": "Specific action for the user",
    "confidence": "high|medium|low"
  }
]
```

### Dashboard: /analyst page

New page displaying the latest analyst report:
- Date header
- For each question/PoV:
  - Question card with "spark" context
  - Research findings (collapsible)
  - Citations as clickable links
  - **PoV** in bold/highlighted box
  - Suggested action
  - Confidence badge (green/amber/gray)
  - Dismiss/Bookmark buttons (reuse Feature 1/2)

### Scheduling

Runs after daily synthesis completes:
1. Synthesis generates briefing + trends
2. Work context refreshes from git
3. Analyst generates questions from synthesis output
4. Analyst researches via pp-cli
5. Analyst synthesizes PoVs
6. Saves to analyst_reports table

Total pipeline: synthesis (1 Sonnet call) -> work_context (1 Haiku call) -> analyst (1 Sonnet + 3-5 pp calls + 1 Sonnet) = ~8 API calls daily.

### launchd Integration

Add to existing synthesis cron or chain after it. The `run_synthesis.py` script runs both synthesis and analyst sequentially.

---

## Data Flow (Complete Pipeline)

```
Git Repos ──> work_context.py ──> value_config["work_context"]
                                         │
                                         ▼
Messages ──> classifier.py ──────> classifications table
    │            │                       │
    │            │ (uses dismissed        │
    │            │  themes + work         │
    │            │  context)              │
    │            ▼                        │
    │     user_feedback ◄────── Dashboard dismiss/bookmark buttons
    │            │                        │
    │            ▼                        │
    └──> synthesis.py ──────────> daily_reports table
              │                          │
              │ (trends + threads)        │
              ▼                          │
         analyst.py                      │
              │                          │
              ├── question generation    │
              ├── pp-cli research        │
              └── PoV synthesis          │
              │                          │
              ▼                          ▼
         analyst_reports ────────> Dashboard /analyst page
```

## New Dashboard Pages

| Page | Purpose |
|------|---------|
| `/queue` | Bookmarked items to follow up on |
| `/analyst` | Agent's curiosity questions + research + PoVs |

## Modified Dashboard Pages

| Page | Changes |
|------|---------|
| `/contribute` | Dismiss + Bookmark buttons on each card |
| `/briefing` | Dismiss + Bookmark buttons on contribution suggestions |
| `/settings` | Add: repo paths for git summarizer, dismissed themes management |
| Nav | Add queue count badge, analyst link |

## API Cost Estimate (Daily)

| Call | Model | Tokens (approx) | Cost |
|------|-------|-----------------|------|
| Synthesis | Sonnet | ~8K in, ~2K out | ~$0.04 |
| Work context | Haiku | ~2K in, ~500 out | ~$0.001 |
| Analyst questions | Sonnet | ~4K in, ~1K out | ~$0.02 |
| Analyst PoV | Sonnet | ~6K in, ~2K out | ~$0.04 |
| Perplexity (3-5 queries) | sonar-reasoning | — | ~$0.05 |
| **Total daily** | | | **~$0.15** |

Plus per-message classification (already running).
