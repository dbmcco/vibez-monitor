# Collective Wisdom Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Wisdom page (knowledge graph from chat history), persistent chat rail, and knowledge extraction pipeline to vibez-monitor.

**Architecture:** Three new DB tables store extracted knowledge (topics, items, recommendations). A daily batch job (Haiku) classifies messages into knowledge types and topic clusters. The dashboard gets a new Wisdom page with two views (By Type / By Topic) and a persistent chat rail replacing the /chat nav page.

**Tech Stack:** Next.js 16, React, Tailwind, SQLite, Anthropic Claude Haiku, Python batch scripts

---

### Task 1: Add wisdom tables to the database schema

**Files:**
- Modify: `backend/vibez/db.py`

**Step 1: Add the three new table definitions to the SCHEMA string**

After the existing `links` table definition (~line 80), add:

```sql
CREATE TABLE IF NOT EXISTS wisdom_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT,
    message_count INTEGER DEFAULT 0,
    contributor_count INTEGER DEFAULT 0,
    last_active DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wisdom_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    knowledge_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    source_links TEXT DEFAULT '[]',
    source_messages TEXT DEFAULT '[]',
    contributors TEXT DEFAULT '[]',
    confidence REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wisdom_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    to_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
    strength REAL DEFAULT 0.0,
    reason TEXT
);
```

**Step 2: Add migration in `init_db()` for existing databases**

In the migrations section of `init_db()`, add a try/except block that creates each table if it doesn't exist (same SQL as above). Follow the existing pattern (~line 117-150).

**Step 3: Verify migration works**

Run:
```bash
cd /Users/braydon/projects/personal/vibez-monitor/backend
python3 -c "from vibez.db import init_db; init_db('vibez.db'); print('OK')"
sqlite3 vibez.db ".schema wisdom_topics"
```
Expected: Table schema printed, no errors.

**Step 4: Commit**

```bash
git add backend/vibez/db.py
git commit -m "feat: add wisdom_topics, wisdom_items, wisdom_recommendations tables"
```

---

### Task 2: Build the wisdom extraction batch job

**Files:**
- Create: `backend/vibez/wisdom.py`
- Create: `backend/scripts/run_wisdom.py`

**Step 1: Create `backend/vibez/wisdom.py`**

This module handles:
1. Fetching unprocessed messages since last watermark
2. Chunking messages into windows (by room + 2-hour window)
3. Sending each chunk to Haiku for classification
4. Aggregating results into topics, items, and recommendations
5. Saving to wisdom tables

```python
# ABOUTME: Knowledge extraction pipeline for collective wisdom.
# ABOUTME: Batch job that classifies messages into knowledge types and topic clusters using Haiku.

"""Extract collective wisdom from chat history into structured knowledge."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from anthropic import Anthropic

from vibez.db import get_connection

logger = logging.getLogger("vibez.wisdom")

KNOWLEDGE_TYPES = [
    "stack", "architecture", "best_practices", "config",
    "research", "tutorial", "news", "opinion", "showcase", "people",
]

CLASSIFICATION_PROMPT = """Analyze these chat messages from a tech community and extract knowledge items.

For each distinct piece of knowledge discussed, classify it:
- knowledge_type: one of {types}
- topic: short topic name (2-4 words, e.g. "agent frameworks", "vector databases", "MCP protocol")
- title: one-line summary of the knowledge (what was said/shared)
- summary: 1-2 sentence synthesis of the group's take
- contributors: list of sender names who contributed to this knowledge
- links: any URLs mentioned in context
- confidence: 0.0-1.0 how clearly this was discussed

Return JSON array. If no extractable knowledge, return [].

Messages:
{messages}"""

CONSENSUS_PROMPT = """Given these knowledge items about "{topic}" from a tech community, write a 2-3 sentence synthesis of what the group collectively thinks about this topic.

Items:
{items}

Write the synthesis as if summarizing the group's collective view. Be specific about tools, preferences, and opinions expressed."""


def _topic_slug(name: str) -> str:
    """Convert topic name to URL-safe slug."""
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower().strip())
    return slug.strip('-')[:80]


def _chunk_messages(messages: list[dict], window_hours: float = 2.0) -> list[list[dict]]:
    """Group messages into chunks by room and time window."""
    if not messages:
        return []

    # Sort by room then timestamp
    sorted_msgs = sorted(messages, key=lambda m: (m.get("room_name", ""), m.get("timestamp", 0)))

    chunks: list[list[dict]] = []
    current_chunk: list[dict] = []
    current_room = ""
    chunk_start_ts = 0
    window_ms = int(window_hours * 3600 * 1000)

    for msg in sorted_msgs:
        room = msg.get("room_name", "")
        ts = msg.get("timestamp", 0)

        if room != current_room or (ts - chunk_start_ts > window_ms and current_chunk):
            if current_chunk:
                chunks.append(current_chunk)
            current_chunk = [msg]
            current_room = room
            chunk_start_ts = ts
        else:
            current_chunk.append(msg)

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def _format_chunk_for_llm(chunk: list[dict]) -> str:
    """Format a message chunk for the classification prompt."""
    lines = []
    for msg in chunk[:30]:  # cap at 30 messages per chunk
        sender = msg.get("sender_name", "?")
        body = msg.get("body", "")[:500]
        room = msg.get("room_name", "")
        lines.append(f"[{room}] {sender}: {body}")
    return "\n".join(lines)


def classify_chunk(client: Anthropic, model: str, chunk: list[dict]) -> list[dict]:
    """Send a message chunk to Haiku for knowledge classification."""
    formatted = _format_chunk_for_llm(chunk)
    if not formatted.strip():
        return []

    prompt = CLASSIFICATION_PROMPT.format(
        types=", ".join(KNOWLEDGE_TYPES),
        messages=formatted,
    )

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = re.sub(r'^```\w*\n?', '', raw)
            raw = re.sub(r'\n?```$', '', raw)
        items = json.loads(raw)
        if not isinstance(items, list):
            return []
        return items
    except Exception:
        logger.exception("Failed to classify chunk")
        return []


def synthesize_topic(client: Anthropic, model: str, topic_name: str, items: list[dict]) -> str:
    """Generate a consensus summary for a topic."""
    items_text = "\n".join(
        f"- [{it.get('knowledge_type', '?')}] {it.get('title', '?')}: {it.get('summary', '')}"
        for it in items[:20]
    )
    prompt = CONSENSUS_PROMPT.format(topic=topic_name, items=items_text)

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.content[0].text.strip()
    except Exception:
        logger.exception("Failed to synthesize topic %s", topic_name)
        return ""


def run_wisdom_extraction(
    db_path: Path,
    api_key: str,
    model: str = "claude-haiku-4-5-20251001",
    full_rebuild: bool = False,
) -> dict[str, int]:
    """Main entry point for the wisdom extraction batch job.

    Returns counts: {chunks_processed, items_extracted, topics_created, recommendations_created}
    """
    conn = get_connection(db_path)

    # Get watermark
    watermark = None
    if not full_rebuild:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key = 'wisdom_last_run'"
        ).fetchone()
        if row:
            watermark = int(row[0])

    # Fetch messages (with URL or substantial content)
    where_parts = ["LENGTH(body) > 20"]
    params: list[Any] = []

    # Exclude non-vibez rooms
    from vibez.links import EXCLUDED_ROOMS
    if EXCLUDED_ROOMS:
        placeholders = ",".join("?" for _ in EXCLUDED_ROOMS)
        where_parts.append(f"room_name NOT IN ({placeholders})")
        params.extend(EXCLUDED_ROOMS)

    if watermark:
        where_parts.append("timestamp > ?")
        params.append(watermark)

    where_sql = " AND ".join(where_parts)
    rows = conn.execute(
        f"SELECT id, body, sender_name, timestamp, room_name FROM messages "
        f"WHERE {where_sql} ORDER BY timestamp ASC",
        params,
    ).fetchall()
    conn.close()

    messages = [
        {"id": r[0], "body": r[1], "sender_name": r[2], "timestamp": r[3], "room_name": r[4]}
        for r in rows
    ]

    logger.info("Processing %d messages for wisdom extraction", len(messages))

    if not messages:
        return {"chunks_processed": 0, "items_extracted": 0, "topics_created": 0, "recommendations_created": 0}

    # Chunk messages
    chunks = _chunk_messages(messages)
    logger.info("Split into %d chunks", len(chunks))

    # Classify each chunk
    client = Anthropic(api_key=api_key)
    all_items: list[dict] = []

    for i, chunk in enumerate(chunks):
        items = classify_chunk(client, model, chunk)
        # Attach source message IDs and timestamps
        msg_ids = [m["id"] for m in chunk]
        for item in items:
            item["_source_messages"] = msg_ids
            item["_chunk_room"] = chunk[0].get("room_name", "")
        all_items.extend(items)
        if (i + 1) % 50 == 0:
            logger.info("  Classified %d/%d chunks (%d items so far)", i + 1, len(chunks), len(all_items))

    logger.info("Extracted %d raw knowledge items", len(all_items))

    # Aggregate by topic
    topic_items: dict[str, list[dict]] = {}
    for item in all_items:
        topic = item.get("topic", "").strip()
        if not topic:
            continue
        slug = _topic_slug(topic)
        if slug not in topic_items:
            topic_items[slug] = []
        topic_items[slug].append({**item, "_slug": slug, "_topic_name": topic})

    # Synthesize consensus for topics with enough signal
    topics_created = 0
    items_saved = 0

    conn = get_connection(db_path)

    if full_rebuild:
        conn.execute("DELETE FROM wisdom_recommendations")
        conn.execute("DELETE FROM wisdom_items")
        conn.execute("DELETE FROM wisdom_topics")

    for slug, items in topic_items.items():
        topic_name = items[0]["_topic_name"]

        # Generate consensus summary for topics with 3+ items
        summary = ""
        if len(items) >= 3:
            summary = synthesize_topic(client, model, topic_name, items)

        # Collect unique contributors
        contributors = set()
        for it in items:
            for c in it.get("contributors", []):
                if isinstance(c, str):
                    contributors.add(c)

        # Collect unique source message IDs
        all_msg_ids = set()
        for it in items:
            for mid in it.get("_source_messages", []):
                all_msg_ids.add(mid)

        # Find latest timestamp
        now = datetime.now().isoformat()

        # Upsert topic
        existing = conn.execute(
            "SELECT id FROM wisdom_topics WHERE slug = ?", (slug,)
        ).fetchone()

        if existing:
            topic_id = existing[0]
            conn.execute(
                "UPDATE wisdom_topics SET summary=?, message_count=?, contributor_count=?, "
                "last_active=?, updated_at=? WHERE id=?",
                (summary or None, len(all_msg_ids), len(contributors), now, now, topic_id),
            )
        else:
            cursor = conn.execute(
                "INSERT INTO wisdom_topics (name, slug, summary, message_count, contributor_count, "
                "last_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (topic_name, slug, summary or None, len(all_msg_ids), len(contributors), now, now, now),
            )
            topic_id = cursor.lastrowid
            topics_created += 1

        # Insert knowledge items (dedupe by title hash within topic)
        seen_titles: set[str] = set()
        for it in items:
            title = it.get("title", "").strip()
            if not title:
                continue
            title_hash = hashlib.md5(f"{slug}:{title}".lower().encode()).hexdigest()
            if title_hash in seen_titles:
                continue
            seen_titles.add(title_hash)

            kt = it.get("knowledge_type", "")
            if kt not in KNOWLEDGE_TYPES:
                kt = "opinion"  # default fallback

            # Collect links from this item
            item_links = it.get("links", [])
            if isinstance(item_links, str):
                item_links = [item_links]

            conn.execute(
                "INSERT INTO wisdom_items (topic_id, knowledge_type, title, summary, "
                "source_links, source_messages, contributors, confidence, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    topic_id, kt, title, it.get("summary", ""),
                    json.dumps(item_links), json.dumps(it.get("_source_messages", [])),
                    json.dumps(list(it.get("contributors", []))),
                    it.get("confidence", 0.5), now, now,
                ),
            )
            items_saved += 1

    # Build recommendation graph (topics that share contributors or co-occur in chunks)
    recs_created = 0
    topic_slugs = list(topic_items.keys())
    topic_contributor_sets: dict[str, set[str]] = {}

    for slug, items in topic_items.items():
        contribs = set()
        for it in items:
            for c in it.get("contributors", []):
                if isinstance(c, str):
                    contribs.add(c)
        topic_contributor_sets[slug] = contribs

    # Clear old recommendations if rebuilding
    if full_rebuild:
        conn.execute("DELETE FROM wisdom_recommendations")

    for i, slug_a in enumerate(topic_slugs):
        for slug_b in topic_slugs[i + 1:]:
            shared = topic_contributor_sets.get(slug_a, set()) & topic_contributor_sets.get(slug_b, set())
            if len(shared) >= 2:  # at least 2 shared contributors
                # Get topic IDs
                a_id = conn.execute("SELECT id FROM wisdom_topics WHERE slug = ?", (slug_a,)).fetchone()
                b_id = conn.execute("SELECT id FROM wisdom_topics WHERE slug = ?", (slug_b,)).fetchone()
                if a_id and b_id:
                    strength = min(1.0, len(shared) / 5.0)
                    reason = f"Shared contributors: {', '.join(sorted(shared)[:5])}"
                    conn.execute(
                        "INSERT INTO wisdom_recommendations (from_topic_id, to_topic_id, strength, reason) "
                        "VALUES (?, ?, ?, ?)",
                        (a_id[0], b_id[0], strength, reason),
                    )
                    recs_created += 1

    # Update watermark
    if messages:
        latest_ts = max(m["timestamp"] for m in messages)
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('wisdom_last_run', ?)",
            (str(latest_ts),),
        )

    conn.commit()
    conn.close()

    result = {
        "chunks_processed": len(chunks),
        "items_extracted": items_saved,
        "topics_created": topics_created,
        "recommendations_created": recs_created,
    }
    logger.info("Wisdom extraction complete: %s", result)
    return result
```

**Step 2: Create `backend/scripts/run_wisdom.py`**

```python
# ABOUTME: Entry point for the wisdom extraction batch job.
# ABOUTME: Run daily or on-demand to extract collective knowledge from chat history.

"""Run the wisdom extraction pipeline."""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibez.wisdom import run_wisdom_extraction


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract collective wisdom from chat history")
    parser.add_argument("db_path", help="Path to vibez.db")
    parser.add_argument("--api-key", help="Anthropic API key (or set ANTHROPIC_API_KEY env)")
    parser.add_argument("--model", default="claude-haiku-4-5-20251001", help="Model for classification")
    parser.add_argument("--full-rebuild", action="store_true", help="Clear and rebuild all wisdom data")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    import os
    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: Set ANTHROPIC_API_KEY or pass --api-key")
        sys.exit(1)

    db_path = Path(args.db_path)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        sys.exit(1)

    result = run_wisdom_extraction(db_path, api_key, model=args.model, full_rebuild=args.full_rebuild)
    print(f"\nWisdom extraction complete:")
    for k, v in result.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
```

**Step 3: Run the extraction on the real database**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/backend
python3 scripts/run_wisdom.py ../vibez.db --full-rebuild
```

Expected: Topics and items created, logged to stdout.

**Step 4: Verify data**

```bash
sqlite3 ../vibez.db "SELECT COUNT(*) FROM wisdom_topics; SELECT COUNT(*) FROM wisdom_items; SELECT COUNT(*) FROM wisdom_recommendations;"
sqlite3 ../vibez.db "SELECT name, message_count, contributor_count FROM wisdom_topics ORDER BY message_count DESC LIMIT 10"
```

**Step 5: Commit**

```bash
git add backend/vibez/wisdom.py backend/scripts/run_wisdom.py
git commit -m "feat: add wisdom extraction pipeline with Haiku classification"
```

---

### Task 3: Add wisdom API endpoints to the dashboard

**Files:**
- Create: `dashboard/src/app/api/wisdom/route.ts`
- Modify: `dashboard/src/lib/db.ts`

**Step 1: Add wisdom query functions to `db.ts`**

At the end of `db.ts` (after `searchLinksFts`), add:

```typescript
// ── Wisdom queries ──────────────────────────────────

export interface WisdomTopic {
  id: number;
  name: string;
  slug: string;
  summary: string | null;
  message_count: number;
  contributor_count: number;
  last_active: string | null;
}

export interface WisdomItem {
  id: number;
  topic_id: number;
  knowledge_type: string;
  title: string;
  summary: string | null;
  source_links: string;
  source_messages: string;
  contributors: string;
  confidence: number;
}

export interface WisdomRecommendation {
  id: number;
  from_topic_id: number;
  to_topic_id: number;
  strength: number;
  reason: string | null;
}

export function getWisdomTopics(): WisdomTopic[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, slug, summary, message_count, contributor_count, last_active
       FROM wisdom_topics ORDER BY message_count DESC`
    )
    .all() as WisdomTopic[];
  db.close();
  return rows;
}

export function getWisdomItemsByType(knowledgeType?: string): Record<string, WisdomItem[]> {
  const db = getDb();
  const where = knowledgeType ? "WHERE wi.knowledge_type = ?" : "";
  const params = knowledgeType ? [knowledgeType] : [];
  const rows = db
    .prepare(
      `SELECT wi.*, wt.name as topic_name, wt.slug as topic_slug
       FROM wisdom_items wi
       JOIN wisdom_topics wt ON wi.topic_id = wt.id
       ${where}
       ORDER BY wi.confidence DESC`
    )
    .all(...params) as (WisdomItem & { topic_name: string; topic_slug: string })[];
  db.close();

  const grouped: Record<string, WisdomItem[]> = {};
  for (const row of rows) {
    const kt = row.knowledge_type;
    if (!grouped[kt]) grouped[kt] = [];
    grouped[kt].push(row);
  }
  return grouped;
}

export function getWisdomItemsByTopic(topicSlug?: string): WisdomTopic & { items: WisdomItem[] } | WisdomTopic[] {
  const db = getDb();
  if (topicSlug) {
    const topic = db
      .prepare("SELECT * FROM wisdom_topics WHERE slug = ?")
      .get(topicSlug) as WisdomTopic | undefined;
    if (!topic) {
      db.close();
      return [];
    }
    const items = db
      .prepare("SELECT * FROM wisdom_items WHERE topic_id = ? ORDER BY confidence DESC")
      .all(topic.id) as WisdomItem[];
    db.close();
    return { ...topic, items };
  }
  const topics = db
    .prepare("SELECT * FROM wisdom_topics ORDER BY message_count DESC")
    .all() as WisdomTopic[];
  db.close();
  return topics;
}

export function getWisdomRecommendations(topicId: number): (WisdomRecommendation & { topic_name: string; topic_slug: string })[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT wr.*, wt.name as topic_name, wt.slug as topic_slug
       FROM wisdom_recommendations wr
       JOIN wisdom_topics wt ON wt.id = CASE
         WHEN wr.from_topic_id = ? THEN wr.to_topic_id
         ELSE wr.from_topic_id
       END
       WHERE wr.from_topic_id = ? OR wr.to_topic_id = ?
       ORDER BY wr.strength DESC`
    )
    .all(topicId, topicId, topicId) as (WisdomRecommendation & { topic_name: string; topic_slug: string })[];
  db.close();
  return rows;
}

export function getWisdomStats(): {
  total_topics: number;
  total_items: number;
  type_counts: { type: string; count: number }[];
  top_contributors: { name: string; count: number }[];
} {
  const db = getDb();
  const total_topics = (db.prepare("SELECT COUNT(*) as c FROM wisdom_topics").get() as { c: number }).c;
  const total_items = (db.prepare("SELECT COUNT(*) as c FROM wisdom_items").get() as { c: number }).c;
  const type_counts = db
    .prepare("SELECT knowledge_type as type, COUNT(*) as count FROM wisdom_items GROUP BY knowledge_type ORDER BY count DESC")
    .all() as { type: string; count: number }[];
  db.close();
  return { total_topics, total_items, type_counts, top_contributors: [] };
}
```

**Step 2: Create the API route `dashboard/src/app/api/wisdom/route.ts`**

```typescript
// ABOUTME: API route for wisdom knowledge graph queries.
// ABOUTME: Supports topic listing, type grouping, drill-down, recommendations, and stats.

import { NextRequest, NextResponse } from "next/server";
import {
  getWisdomTopics,
  getWisdomItemsByType,
  getWisdomItemsByTopic,
  getWisdomRecommendations,
  getWisdomStats,
} from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    // Stats request
    if (params.get("stats") === "1") {
      return NextResponse.json(getWisdomStats());
    }

    // By type view
    if (params.has("type")) {
      const knowledgeType = params.get("type") || undefined;
      return NextResponse.json({ items: getWisdomItemsByType(knowledgeType) });
    }

    // Single topic drill-down
    if (params.has("topic")) {
      const slug = params.get("topic")!;
      const topic = getWisdomItemsByTopic(slug);
      return NextResponse.json(topic);
    }

    // Recommendations for a topic
    if (params.has("recommendations")) {
      const topicId = parseInt(params.get("recommendations")!, 10);
      return NextResponse.json({ recommendations: getWisdomRecommendations(topicId) });
    }

    // Default: all topics
    return NextResponse.json({ topics: getWisdomTopics() });
  } catch (err) {
    console.error("Wisdom API error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
```

**Step 3: Verify the API works**

```bash
curl -s http://localhost:3100/api/wisdom | python3 -m json.tool | head -20
curl -s 'http://localhost:3100/api/wisdom?stats=1' | python3 -m json.tool
curl -s 'http://localhost:3100/api/wisdom?type=stack' | python3 -m json.tool | head -20
```

**Step 4: Commit**

```bash
git add dashboard/src/lib/db.ts dashboard/src/app/api/wisdom/route.ts
git commit -m "feat: add wisdom API endpoints for topics, items, types, and recommendations"
```

---

### Task 4: Build the Wisdom page

**Files:**
- Create: `dashboard/src/app/wisdom/page.tsx`

**Step 1: Create the Wisdom page**

```tsx
// ABOUTME: Wisdom page — collective knowledge graph from group chat history.
// ABOUTME: Two views (By Type / By Topic) with drill-down into synthesized knowledge.

"use client";

import { useEffect, useState, useCallback } from "react";

interface WisdomTopic {
  id: number;
  name: string;
  slug: string;
  summary: string | null;
  message_count: number;
  contributor_count: number;
  last_active: string | null;
}

interface WisdomItem {
  id: number;
  topic_id: number;
  knowledge_type: string;
  title: string;
  summary: string | null;
  source_links: string;
  source_messages: string;
  contributors: string;
  confidence: number;
  topic_name?: string;
  topic_slug?: string;
}

interface WisdomStats {
  total_topics: number;
  total_items: number;
  type_counts: { type: string; count: number }[];
}

interface Recommendation {
  id: number;
  topic_name: string;
  topic_slug: string;
  strength: number;
  reason: string | null;
}

const KNOWLEDGE_TYPE_META: Record<string, { label: string; color: string; description: string }> = {
  stack: { label: "Stack", color: "text-emerald-400", description: "Tools, frameworks, libraries" },
  architecture: { label: "Architecture", color: "text-violet-400", description: "System design, patterns" },
  best_practices: { label: "Best Practices", color: "text-amber-400", description: "How to do things well" },
  config: { label: "Config", color: "text-sky-400", description: "Setup guides, environment configs" },
  research: { label: "Research", color: "text-rose-400", description: "Papers, deep dives, novel ideas" },
  tutorial: { label: "Tutorials", color: "text-cyan-400", description: "Walkthroughs, getting-started" },
  news: { label: "News", color: "text-orange-400", description: "Launches, releases, announcements" },
  opinion: { label: "Opinion", color: "text-pink-400", description: "Analysis, comparisons, hot takes" },
  showcase: { label: "Showcase", color: "text-lime-400", description: "Demos, look what I built" },
  people: { label: "People & Orgs", color: "text-indigo-400", description: "Who to follow, teams" },
};

type ViewMode = "by-type" | "by-topic";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseJsonArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
        active
          ? "border-cyan-400/60 bg-cyan-900/30 text-cyan-200"
          : "border-slate-700/50 text-slate-500 hover:border-slate-500 hover:text-slate-400"
      }`}
    >
      {children}
    </button>
  );
}

export default function WisdomPage() {
  const [view, setView] = useState<ViewMode>("by-type");
  const [stats, setStats] = useState<WisdomStats | null>(null);
  const [topics, setTopics] = useState<WisdomTopic[]>([]);
  const [typeItems, setTypeItems] = useState<Record<string, WisdomItem[]>>({});
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<WisdomTopic | null>(null);
  const [topicItems, setTopicItems] = useState<WisdomItem[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/wisdom?stats=1");
      setStats(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchTopics = useCallback(async () => {
    try {
      const res = await fetch("/api/wisdom");
      const data = await res.json();
      setTopics(data.topics || []);
    } catch { /* ignore */ }
  }, []);

  const fetchTypeItems = useCallback(async (type?: string) => {
    setLoading(true);
    try {
      const url = type ? `/api/wisdom?type=${type}` : "/api/wisdom?type=";
      const res = await fetch(url);
      const data = await res.json();
      setTypeItems(data.items || {});
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const fetchTopicDetail = useCallback(async (slug: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/wisdom?topic=${slug}`);
      const data = await res.json();
      if (data.id) {
        setSelectedTopic(data);
        setTopicItems(data.items || []);
        // Fetch recommendations
        const recRes = await fetch(`/api/wisdom?recommendations=${data.id}`);
        const recData = await recRes.json();
        setRecommendations(recData.recommendations || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStats();
    fetchTopics();
    fetchTypeItems();
  }, [fetchStats, fetchTopics, fetchTypeItems]);

  function handleTypeClick(type: string) {
    if (selectedType === type) {
      setSelectedType(null);
      fetchTypeItems();
    } else {
      setSelectedType(type);
      fetchTypeItems(type);
    }
  }

  function handleTopicClick(topic: WisdomTopic) {
    setSelectedTopic(topic);
    fetchTopicDetail(topic.slug);
  }

  function handleBack() {
    setSelectedTopic(null);
    setTopicItems([]);
    setRecommendations([]);
  }

  return (
    <div className="fade-up space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="vibe-title text-2xl text-slate-100">Wisdom</h1>
          <p className="vibe-subtitle text-sm">
            Collective knowledge from {stats ? stats.total_topics : "..."} topics
            {" · "}{stats ? stats.total_items : "..."} insights extracted from group conversations.
          </p>
        </div>
      </header>

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <Pill active={view === "by-type"} onClick={() => { setView("by-type"); handleBack(); }}>
          By Type
        </Pill>
        <Pill active={view === "by-topic"} onClick={() => { setView("by-topic"); handleBack(); }}>
          By Topic
        </Pill>
      </div>

      {/* By Type view */}
      {view === "by-type" && !selectedTopic && (
        <div className="space-y-4">
          {/* Type cards grid */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(KNOWLEDGE_TYPE_META).map(([type, meta]) => {
              const count = stats?.type_counts.find(t => t.type === type)?.count || 0;
              const isActive = selectedType === type;
              return (
                <button
                  key={type}
                  onClick={() => handleTypeClick(type)}
                  className={`rounded-lg border p-4 text-left transition ${
                    isActive
                      ? "border-cyan-400/50 bg-cyan-900/20"
                      : "border-slate-800/60 hover:border-slate-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
                    <span className="text-xs text-slate-500">{count}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{meta.description}</p>
                </button>
              );
            })}
          </div>

          {/* Items list for selected type */}
          {loading && <p className="text-sm text-slate-500">Loading...</p>}
          {!loading && Object.keys(typeItems).length > 0 && (
            <div className="space-y-3">
              {Object.entries(typeItems).map(([type, items]) => {
                if (selectedType && type !== selectedType) return null;
                const meta = KNOWLEDGE_TYPE_META[type] || { label: type, color: "text-slate-400" };
                return (
                  <div key={type}>
                    {!selectedType && (
                      <h3 className={`mb-2 text-sm font-medium ${meta.color}`}>{meta.label}</h3>
                    )}
                    <div className="overflow-hidden rounded-lg border border-slate-800/60">
                      <table className="w-full text-left text-sm">
                        <tbody className="divide-y divide-slate-800/40">
                          {items.slice(0, selectedType ? 50 : 5).map((item) => {
                            const contributors = parseJsonArray(item.contributors);
                            return (
                              <tr key={item.id} className="group transition hover:bg-slate-800/20">
                                <td className="px-3 py-2">
                                  <p className="text-sm text-slate-200">{item.title}</p>
                                  {item.summary && (
                                    <p className="mt-0.5 line-clamp-1 text-xs text-slate-400">{item.summary}</p>
                                  )}
                                </td>
                                <td className="hidden px-3 py-2 text-xs text-slate-500 sm:table-cell">
                                  {contributors.slice(0, 3).join(", ")}
                                </td>
                                <td className="px-3 py-2 text-right text-xs text-slate-500">
                                  {Math.round(item.confidence * 100)}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* By Topic view */}
      {view === "by-topic" && !selectedTopic && (
        <div className="space-y-3">
          {topics.length === 0 && !loading && (
            <p className="py-8 text-center text-sm text-slate-500">No wisdom topics extracted yet.</p>
          )}
          <div className="overflow-hidden rounded-lg border border-slate-800/60">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800/60 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Topic</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Messages</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Contributors</th>
                  <th className="px-3 py-2 text-right">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {topics.map((topic) => (
                  <tr
                    key={topic.id}
                    className="group cursor-pointer transition hover:bg-slate-800/20"
                    onClick={() => handleTopicClick(topic)}
                  >
                    <td className="px-3 py-2">
                      <p className="font-medium text-slate-200 group-hover:text-cyan-300">{topic.name}</p>
                      {topic.summary && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-slate-400">{topic.summary}</p>
                      )}
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-slate-500 sm:table-cell">
                      {topic.message_count}
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-slate-500 sm:table-cell">
                      {topic.contributor_count}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-slate-500">
                      {formatDate(topic.last_active)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Topic detail drill-down */}
      {selectedTopic && (
        <div className="space-y-4">
          <button
            onClick={handleBack}
            className="text-xs text-slate-500 hover:text-cyan-300 transition"
          >
            ← Back to {view === "by-type" ? "types" : "topics"}
          </button>

          <div className="vibe-panel rounded-xl p-5">
            <h2 className="vibe-title text-xl text-slate-100">{selectedTopic.name}</h2>
            {selectedTopic.summary && (
              <p className="mt-2 text-sm text-slate-300">{selectedTopic.summary}</p>
            )}
            <div className="mt-3 flex gap-4 text-xs text-slate-500">
              <span>{selectedTopic.message_count} messages</span>
              <span>{selectedTopic.contributor_count} contributors</span>
              <span>Last active {formatDate(selectedTopic.last_active)}</span>
            </div>
          </div>

          {/* Knowledge items grouped by type */}
          {(() => {
            const grouped: Record<string, WisdomItem[]> = {};
            for (const item of topicItems) {
              const kt = item.knowledge_type;
              if (!grouped[kt]) grouped[kt] = [];
              grouped[kt].push(item);
            }
            return Object.entries(grouped).map(([type, items]) => {
              const meta = KNOWLEDGE_TYPE_META[type] || { label: type, color: "text-slate-400" };
              return (
                <div key={type}>
                  <h3 className={`mb-2 text-sm font-medium ${meta.color}`}>{meta.label}</h3>
                  <div className="space-y-2">
                    {items.map((item) => (
                      <div key={item.id} className="rounded-lg border border-slate-800/60 p-3">
                        <p className="text-sm text-slate-200">{item.title}</p>
                        {item.summary && (
                          <p className="mt-1 text-xs text-slate-400">{item.summary}</p>
                        )}
                        <div className="mt-2 flex gap-2 text-[10px] text-slate-500">
                          {parseJsonArray(item.contributors).slice(0, 5).map((c) => (
                            <span key={c} className="rounded border border-slate-700/50 px-1.5 py-0.5">{c}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            });
          })()}

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-slate-300">Related Topics</h3>
              <div className="flex flex-wrap gap-2">
                {recommendations.map((rec) => (
                  <button
                    key={rec.id}
                    onClick={() => fetchTopicDetail(rec.topic_slug)}
                    className="rounded-full border border-slate-700/50 px-3 py-1 text-xs text-slate-400 transition hover:border-cyan-400/50 hover:text-cyan-300"
                  >
                    {rec.topic_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Verify the page renders**

Visit `http://localhost:3100/wisdom` — should show the page (may be empty if extraction hasn't run yet).

**Step 3: Commit**

```bash
git add dashboard/src/app/wisdom/page.tsx
git commit -m "feat: add Wisdom page with By Type and By Topic views"
```

---

### Task 5: Update navigation — add Wisdom, remove Chat from nav

**Files:**
- Modify: `dashboard/src/components/Nav.tsx`

**Step 1: Update the nav links array and page intents**

Replace the `ALL_LINKS` array and update `PAGE_INTENT`:

```typescript
const ALL_LINKS = [
  { href: "/briefing", label: "Briefing" },
  { href: "/links", label: "Links" },
  { href: "/wisdom", label: "Wisdom" },
  { href: "/stats", label: "Stats" },
  { href: "/spaces", label: "Groups" },
  { href: "/settings", label: "Settings" },
];
```

Add to `PAGE_INTENT`:
```typescript
  "/wisdom": "Collective knowledge: topics, patterns, and recommendations distilled from group conversations.",
```

Update the `activeLabel` fallback to remove the Contribute special case (or keep it if desired).

**Step 2: Verify**

Visit `http://localhost:3100` — nav should show Briefing, Links, Wisdom, Stats, Groups, Settings. No Chat in nav.

**Step 3: Commit**

```bash
git add dashboard/src/components/Nav.tsx
git commit -m "feat: update nav — add Wisdom, remove Chat from top nav"
```

---

### Task 6: Build the persistent chat rail component

**Files:**
- Create: `dashboard/src/components/ChatRail.tsx`
- Modify: `dashboard/src/app/layout.tsx`
- Modify: `dashboard/src/app/globals.css`

**Step 1: Create `dashboard/src/components/ChatRail.tsx`**

Port the LFW assistant-rail pattern to React/Next.js:

```tsx
// ABOUTME: Persistent chat rail component — always-available chat panel on the right side.
// ABOUTME: Follows LFW Graph CRM assistant-rail pattern: resizable, collapsible, page-aware.

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "vibez-chat-rail";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 300;
const MAX_WIDTH = 700;

const PAGE_LABELS: Record<string, string> = {
  "/": "Home",
  "/briefing": "Briefing",
  "/links": "Links",
  "/wisdom": "Wisdom",
  "/stats": "Stats",
  "/spaces": "Groups",
  "/settings": "Settings",
};

const STARTER_PROMPTS = [
  "What's the group been talking about lately?",
  "Who shares the most useful links?",
  "What are the hottest topics this week?",
  "Summarize recent architecture discussions",
];

function loadState(): { width: number; collapsed: boolean; threads: Record<string, ChatMessage[]> } {
  if (typeof window === "undefined") return { width: DEFAULT_WIDTH, collapsed: false, threads: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { width: DEFAULT_WIDTH, collapsed: false, threads: {} };
}

function saveState(state: { width: number; collapsed: boolean; threads: Record<string, ChatMessage[]> }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function ChatRail() {
  const pathname = usePathname();
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const threadRef = useRef(messages);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Load persisted state on mount
  useEffect(() => {
    const state = loadState();
    setWidth(state.width);
    setCollapsed(state.collapsed);
    setThreads(state.threads);
  }, []);

  // Switch thread when pathname changes
  useEffect(() => {
    const thread = threads[pathname] || [];
    setMessages(thread);
    threadRef.current = thread;
  }, [pathname, threads]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Persist state changes
  const persist = useCallback((w: number, c: boolean, t: Record<string, ChatMessage[]>) => {
    saveState({ width: w, collapsed: c, threads: t });
  }, []);

  // Resize handler
  useEffect(() => {
    const resizer = resizerRef.current;
    if (!resizer) return;

    let startX = 0;
    let startWidth = 0;

    function onMouseMove(e: MouseEvent) {
      const delta = startX - e.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist final width
      setWidth((w) => {
        persist(w, collapsed, threads);
        return w;
      });
    }

    function onMouseDown(e: MouseEvent) {
      startX = e.clientX;
      startWidth = width;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    resizer.addEventListener("mousedown", onMouseDown);
    return () => resizer.removeEventListener("mousedown", onMouseDown);
  }, [width, collapsed, threads, persist]);

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text.trim() };
    const updatedMessages = [...threadRef.current, userMsg];
    setMessages(updatedMessages);
    threadRef.current = updatedMessages;
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text.trim(),
          history: updatedMessages.slice(-10),
          context: { page: pathname, pageLabel: PAGE_LABELS[pathname] || pathname },
        }),
      });
      const data = await res.json();
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: data.answer || data.error || "No response",
      };
      const newThread = [...updatedMessages, assistantMsg];
      setMessages(newThread);
      threadRef.current = newThread;
      const newThreads = { ...threads, [pathname]: newThread };
      setThreads(newThreads);
      persist(width, collapsed, newThreads);
    } catch {
      const errMsg: ChatMessage = { role: "assistant", content: "Failed to reach the chat agent." };
      const newThread = [...updatedMessages, errMsg];
      setMessages(newThread);
      threadRef.current = newThread;
    }
    setLoading(false);
  }

  function toggleCollapse() {
    const next = !collapsed;
    setCollapsed(next);
    persist(width, next, threads);
  }

  const pageLabel = PAGE_LABELS[pathname] || "Page";

  // Collapsed FAB
  if (collapsed) {
    return (
      <button
        onClick={toggleCollapse}
        className="chat-rail-fab fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-400/40 bg-slate-900/95 text-cyan-300 shadow-lg transition hover:bg-slate-800 hover:shadow-cyan-400/20"
        title="Open chat"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    );
  }

  return (
    <div
      ref={railRef}
      className="chat-rail hidden lg:flex"
      style={{ width: `${width}px`, minWidth: `${MIN_WIDTH}px`, maxWidth: `${MAX_WIDTH}px` }}
    >
      {/* Resize handle */}
      <div
        ref={resizerRef}
        className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-cyan-400/20 transition"
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Chat</h2>
          <p className="text-[10px] text-slate-500">Context: {pageLabel}</p>
        </div>
        <button
          onClick={toggleCollapse}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition"
        >
          Hide
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Ask anything about what the group has discussed.</p>
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => sendMessage(prompt)}
                className="block w-full rounded border border-slate-700/50 px-2.5 py-1.5 text-left text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-300"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs leading-relaxed ${
              msg.role === "user"
                ? "ml-6 rounded-lg bg-cyan-900/30 px-3 py-2 text-cyan-100"
                : "text-slate-300"
            }`}
          >
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="vibe-spinner inline-block h-3 w-3 rounded-full border-2 border-slate-600 border-t-cyan-400" />
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-800 px-3 py-2">
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about ${pageLabel.toLowerCase()}...`}
            className="vibe-input flex-1 rounded-md px-2.5 py-1.5 text-xs"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-cyan-900/40 px-3 py-1.5 text-xs text-cyan-300 transition hover:bg-cyan-800/50 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
```

**Step 2: Add chat rail CSS to `dashboard/src/app/globals.css`**

At the end of the file, add:

```css
/* Chat rail — persistent right panel */
.chat-rail {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  flex-direction: column;
  background: rgba(7, 12, 18, 0.97);
  border-left: 1px solid var(--border);
  z-index: 30;
}

.chat-rail-fab {
  /* Shown on desktop only when rail is collapsed */
}

@media (max-width: 1023px) {
  .chat-rail { display: none !important; }
  .chat-rail-fab { display: none !important; }
}
```

**Step 3: Update `dashboard/src/app/layout.tsx` to include the chat rail and adjust main content**

```tsx
import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ChatRail } from "@/components/ChatRail";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "vibez-monitor",
  description: "WhatsApp attention firewall for the Vibez ecosystem",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
      { url: "/icons/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/icons/favicon-32x32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable}`}
    >
      <body className="text-slate-100 antialiased">
        <Nav />
        <div className="lg:mr-[380px]">
          <main className="vibe-shell mx-auto max-w-6xl px-4 py-8 sm:px-6">
            {children}
          </main>
        </div>
        <ChatRail />
      </body>
    </html>
  );
}
```

Note: `lg:mr-[380px]` reserves space for the chat rail on large screens. When the rail is collapsed, the margin stays but the FAB floats. A future refinement could make this dynamic.

**Step 4: Verify**

Visit `http://localhost:3100` — should see the chat rail on the right side. Test:
- Type a question and send
- Navigate between pages (thread should switch)
- Collapse and reopen via FAB
- Resize by dragging the left edge

**Step 5: Commit**

```bash
git add dashboard/src/components/ChatRail.tsx dashboard/src/app/layout.tsx dashboard/src/app/globals.css
git commit -m "feat: add persistent chat rail with page-aware context and resize/collapse"
```

---

### Task 7: Wire chat API to accept page context

**Files:**
- Modify: `dashboard/src/app/api/chat/route.ts`

**Step 1: Accept and use the `context` parameter**

In the request body parsing (around line 66-78), add extraction of the context parameter:

```typescript
const context = body.context as { page?: string; pageLabel?: string } | undefined;
```

In the system prompt or user message construction, prepend the page context:

```typescript
const contextPrefix = context?.pageLabel
  ? `The user is currently viewing the "${context.pageLabel}" page of the vibez dashboard. `
  : "";
```

Add `contextPrefix` to the beginning of the user message or system prompt where appropriate.

**Step 2: Verify**

Open the chat rail on the Wisdom page, ask a question. The response should acknowledge the page context if relevant.

**Step 3: Commit**

```bash
git add dashboard/src/app/api/chat/route.ts
git commit -m "feat: pass page context from chat rail to chat API"
```

---

### Task 8: Deploy and verify end-to-end

**Step 1: Run the wisdom extraction pipeline**

```bash
cd /Users/braydon/projects/personal/vibez-monitor/backend
python3 scripts/run_wisdom.py ../vibez.db --full-rebuild
```

**Step 2: Verify locally**

- Visit `/wisdom` — should show populated topics and type cards
- Toggle between By Type and By Topic views
- Click into a topic to see drill-down with items and recommendations
- Test chat rail on multiple pages
- Test collapse/resize/thread persistence

**Step 3: Push to GitHub**

```bash
cd /Users/braydon/projects/personal/vibez-monitor
git push origin main
```

**Step 4: Deploy to Railway**

```bash
railway up
```

**Step 5: Run wisdom extraction for Railway DB**

This needs to happen on Railway or via the push pipeline — coordinate with Braydon on how to get the wisdom tables populated on Railway.
