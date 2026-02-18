# Vibez Monitor — Design Document

**Date:** 2026-02-18
**Status:** Approved
**Author:** Braydon + Claude

## Overview

An agentic daily monitoring system for the Vibez WhatsApp ecosystem (10 groups, 118+ participants, ~60 msgs/day). Implements the "Attention Firewall" pattern: capture the firehose, classify in real-time, synthesize daily, surface what matters.

## Problem

The Vibez group is extremely valuable — cutting-edge AI agentic discussion — but the volume is overwhelming. Braydon needs to:
1. Stay engaged bidirectionally without reading everything
2. Extract value (key threads, decisions, tools, links)
3. Contribute value back (identify where his knowledge/projects are relevant)

## Approach

**Approach B: Event-Driven Pipeline** — Matrix sync stream + Sonnet classifier + daily Sonnet/Opus synthesis + Next.js dashboard.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    vibez-monitor                             │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Matrix Sync  │───▶│  Classifier  │───▶│   SQLite DB  │  │
│  │  (long-poll)  │    │  (Sonnet)    │    │  (messages,  │  │
│  │              │    │              │    │   tags, scores)│  │
│  └──────────────┘    └──────┬───────┘    └──────┬───────┘  │
│                             │                    │          │
│                      high-signal?          ┌─────▼───────┐  │
│                             │              │ Daily Synth  │  │
│                      ┌──────▼───────┐      │ (Sonnet/Opus)│  │
│                      │  Hot Queue   │      │  6am cron    │  │
│                      │  (alerts)    │      └─────┬───────┘  │
│                      └──────┬───────┘            │          │
│                             │              ┌─────▼───────┐  │
│                             └─────────────▶│  Dashboard   │  │
│                                            │  (Next.js)   │  │
│                                            └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Four Components

1. **Matrix Sync Service** (Python, persistent process via launchd)
   - Long-polls `matrix.beeper.com` using Beeper access token
   - Filters to WhatsApp-bridged rooms only
   - Writes raw events to SQLite
   - Handles reconnection, incremental sync tokens

2. **Real-time Classifier** (inline, Sonnet calls)
   - Runs on each new message batch
   - Tags: topic category, relevance score (0-10), contribution-opportunity flag, key-entity extraction
   - Cost: ~$0.10/day at current volume

3. **Daily Synthesis Agent** (cron, Sonnet or Opus)
   - Runs at 6am, reads last 24h of classified messages
   - Generates: morning briefing, contribution map, trend shifts
   - Stores report as structured JSON + rendered markdown
   - Cost: ~$0.15-0.75/day depending on model

4. **Dashboard** (Next.js, local)
   - Live feed with real-time updates
   - Daily briefing view
   - Contribution opportunities panel
   - Thread drill-down
   - Value tuning settings

## Data Model

```sql
-- Raw messages from Matrix sync
messages (
  id TEXT PRIMARY KEY,          -- Matrix event_id
  room_id TEXT,                 -- Matrix room ID
  room_name TEXT,               -- "The vibez (code code code)", etc.
  sender_id TEXT,               -- Matrix user ID
  sender_name TEXT,             -- Display name
  body TEXT,                    -- Message content
  timestamp INTEGER,            -- Unix ms
  raw_event JSON,               -- Full Matrix event for future use
  created_at DATETIME
)

-- Classifier output (one per message)
classifications (
  message_id TEXT PRIMARY KEY,  -- FK to messages
  relevance_score INTEGER,      -- 0-10
  topics JSON,                  -- ["agentic-arch", "tool-drop", "amplifier"]
  entities JSON,                -- ["amplifier", "projector", "beeper"]
  contribution_flag BOOLEAN,
  contribution_hint TEXT,
  alert_level TEXT,             -- "none" | "digest" | "hot"
  classified_at DATETIME
)

-- Daily synthesis reports
daily_reports (
  id INTEGER PRIMARY KEY,
  report_date DATE UNIQUE,
  briefing_md TEXT,
  briefing_json JSON,
  contributions JSON,
  trends JSON,
  stats JSON,
  generated_at DATETIME
)

-- Personal value configuration
value_config (
  key TEXT PRIMARY KEY,
  value JSON
)

-- Sync state
sync_state (
  key TEXT PRIMARY KEY,
  value TEXT
)
```

## Classifier Design

**Model:** Claude Sonnet (claude-sonnet-4-6)

Runs on each message batch. Prompt classifies against Braydon's value config:
- Agentic architecture patterns (multi-agent, context management, orchestration)
- Practical tools and repos (actionable links, libraries)
- Business application of AI (workflows, productivity)
- Intersection with personal projects (MoneyCommand, Amplifier, driftdriver, workgraph, home automation)

Output: structured JSON with relevance_score, topics, entities, contribution_flag, contribution_hint, alert_level.

## Synthesis Agent Design

**Model:** Claude Sonnet or Opus

Runs daily at 6am. Reads all classified messages from last 24h. Generates:
1. **Briefing** — Top 3-5 threads: title, participants, key insights, links
2. **Contributions** — Where Braydon can add value: thread reference, why, suggested action
3. **Trends** — Topic shifts week-over-week, emerging themes, who's driving what
4. **Links** — Top links shared, categorized and annotated

Includes yesterday's briefing for continuity.

## Matrix Sync Service Design

Persistent Python process managed by launchd.

Core loop:
1. Load `next_batch` token from `sync_state`
2. Long-poll `GET /_matrix/client/v3/sync?since={next_batch}&timeout=30000`
3. Filter to WhatsApp-bridged rooms (rooms with `m.bridge` state events)
4. For each `m.room.message`: write to DB, classify, alert if hot
5. Save new `next_batch` token, loop

Resilience: launchd auto-restart, exponential backoff, sync token prevents reprocessing.

## Dashboard Design

**Next.js 14+ (App Router), Tailwind CSS, better-sqlite3, local-first.**

Four views:
1. **Live Feed** (`/`) — Auto-refreshing stream, color-coded by relevance, filterable
2. **Morning Briefing** (`/briefing`) — Today's synthesis, expandable threads, calendar nav
3. **Contribution Board** (`/contribute`) — Card layout, status tracking, Beeper deep links
4. **Settings** (`/settings`) — Value config editor, relevance thresholds, sync status

SSE endpoint for live updates from hot alerts. No auth (local machine only).

## Data Source

Beeper (installed, WhatsApp bridge connected and running) provides a Matrix protocol interface to all WhatsApp messages. Access via Matrix Client-Server API at `matrix.beeper.com`.

Existing WhatsApp chat exports (10 zips, Jan 29 snapshot) can be used for backfill and testing.

## Future Extensions (Not in Scope)

- Multi-channel (LinkedIn, Slack, Twitter via Beeper bridges)
- Agent-authored draft responses
- Amplifier integration for synthesis agent
- Cross-platform correlation
