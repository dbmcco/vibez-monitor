# Links Feature Design

**Date**: 2026-03-10
**Status**: Approved

## Overview

Add a first-class Links section to vibez-monitor that surfaces all shared links from group chats, classifies them, ranks by value, and offers NLP search (e.g. "that repo Dan shared about retrying features").

## Data Model

### `links` table

```sql
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    title TEXT,
    category TEXT,
    relevance TEXT,
    shared_by TEXT,
    source_group TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    mention_count INTEGER DEFAULT 1,
    value_score REAL DEFAULT 0,
    report_date DATE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url_hash ON links (url_hash);
CREATE INDEX IF NOT EXISTS idx_links_category ON links (category);
CREATE INDEX IF NOT EXISTS idx_links_value_score ON links (value_score);
CREATE INDEX IF NOT EXISTS idx_links_last_seen ON links (last_seen);
```

### Value Score

Composite of:
- `mention_count` — same link shared across groups/days
- Recency — decay over time from `last_seen`
- LLM relevance — from synthesis extraction

Recomputed on each new mention (upsert).

### Link Embeddings (pgvector)

Embedding generated from composite text: `"{title} | {category} | {relevance} | shared by {shared_by} in {source_group}"`.

Stored in pgvector table `vibez_link_embeddings` using same infra as message embeddings.

## NLP Search

Primary interaction is a natural language search bar. User describes what they remember, system finds it via vector similarity.

### Search Flow

1. User types query -> `GET /api/links?q=...`
2. Backend embeds query string
3. pgvector cosine similarity against link embeddings
4. Return top N results, optionally filtered by category/date

### FTS5 Fallback

When pgvector unavailable (e.g. Railway without pg), fall back to SQLite FTS5 over `title || relevance` columns.

## API

### `GET /api/links`

Query params:
- `q` — NLP search query (pgvector or FTS fallback)
- `category` — optional filter: `tool|repo|article|discussion`
- `days` — date range, default 14
- `limit` — pagination, default 50

Response:
```json
{
  "links": [
    {
      "id": 1,
      "url": "https://github.com/...",
      "title": "Trycycle - multi-attempt feature builder",
      "category": "repo",
      "relevance": "Directly relevant to agent retry patterns",
      "shared_by": "Dan",
      "source_group": "The vibez",
      "first_seen": "2026-03-08T...",
      "mention_count": 3,
      "value_score": 0.85
    }
  ],
  "total": 42
}
```

## Frontend

### Navigation

New `/links` page in nav, between Briefing and Stats.

### Layout

- **Search bar** — large, prominent. Placeholder: "Describe what you're looking for..."
- **Category pills** — `All | Tools | Repos | Articles | Discussions` — optional post-filters
- **Results list** — each link card:
  - Title (clickable, opens in new tab)
  - Domain hostname
  - Category badge
  - Relevance blurb
  - Shared by / source group / date
  - Mention count badge if >1
- **Empty state** — starter prompts: "Repos shared this week", "Tools for agent orchestration", "Most discussed links"
- Sorted by value_score desc; search results sorted by similarity

## Ingestion

### Synthesis Hook

After `briefing_json` saved to `daily_reports`, parse `links` array and upsert into `links` table. On duplicate URL (by url_hash): bump mention_count, update last_seen, recalculate value_score.

### Backfill Migration

One-time script parses existing `daily_reports.briefing_json` rows and populates `links` table with historical data.

## E2E Tests

1. **Ingestion** — synthesis produces report, links land in DB with correct fields
2. **Dedup** — same URL from two reports, mention_count increments, value_score updates
3. **API NLP search** — seed links, query with natural language, verify ranked results
4. **API filters** — category and date range filters return correct subsets
5. **Frontend page load** — links page renders, search bar present, results display
6. **Frontend search flow** — type query, results update, click opens new tab
7. **Backfill** — run migration on existing reports, historical links appear
8. **FTS fallback** — search works when pgvector unavailable

## Categories

Existing 4 categories retained: `tool | repo | article | discussion`. Expandable later.

## Non-Goals

- Sharer reputation scoring (future iteration)
- Discussion volume tracking per link (future)
- Link preview/thumbnail fetching (future)
