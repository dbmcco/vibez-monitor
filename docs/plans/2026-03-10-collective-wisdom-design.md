# Collective Wisdom — Design Document

## Goal

Transform the vibez group's entire chat history into organized, navigable collective knowledge — not just a link directory, but a synthesized knowledge graph with categories, topic clusters, and recommendation connections.

## Navigation & Layout Changes

**Nav bar:** Briefing | Stats | Links | Wisdom

**Chat rail (persistent):**
- Replaces `/chat` as a nav page
- Right-side panel, 440px default, resizable 340–920px, collapsible with FAB
- Follows LFW Graph CRM assistant-rail pattern
- Page-aware: passes current page context so responses are relevant
- Per-scope thread history in localStorage
- Hidden on mobile

## Wisdom Page

Two toggle views on the same page: **By Type** and **By Topic**.

### By Type View

Category cards for each knowledge type:

| Type | Description |
|------|-------------|
| Stack | Tools, frameworks, libraries |
| Architecture | System design, patterns |
| Best Practices | How to do things well |
| Config | Setup guides, environment configs |
| Research | Papers, deep dives, novel ideas |
| Tutorials | Walkthroughs, getting-started |
| News | Launches, releases, announcements |
| Opinion | Analysis, comparisons, hot takes |
| Showcase | Demos, "look what I built" |
| People & Orgs | Who to follow, teams |

Each card shows: item count, 2-3 recent highlights, top contributors. Click into a card for full list with synthesized summaries.

### By Topic View

Clustered by subject (agent frameworks, vector DBs, MCP, sandboxing, etc.). Each topic shows:
- Which knowledge types exist within it
- Short synthesized summary of the group's collective take
- Top contributors
- Related links and message evidence

### Recommendation Clusters

Appear in both views:
- "Related topics" connections
- "People who explored X also shared Y"
- Displayed at bottom of drill-in pages and as sidebar suggestions

## Knowledge Extraction Pipeline

**Batch job**, runs daily or on-demand. Similar to the briefing pipeline.

### Processing Steps

1. **Chunk recent messages** by room and time window
2. **LLM classification** (Haiku) for each chunk:
   - Knowledge type (stack, architecture, best practices, etc.)
   - Topics mentioned (extracted as tags)
   - Key claims or opinions expressed
   - Links referenced and their role in the discussion
3. **Aggregation** — merge chunks into topic clusters, deduplicate, build cross-references
4. **Synthesis pass** — for each topic with enough signal, generate 2-3 sentence "group consensus" summary
5. **Recommendation graph** — connect topics that co-occur in conversations or share contributors

### Incremental Behavior

Each run processes only messages newer than the last watermark (`wisdom_last_run` in `sync_state`). Full rebuild available on-demand.

### Cost Estimate

~2,000 messages/day across all rooms. Haiku classification ~$0.01-0.02/day. Synthesis summaries ~$0.05 on heavier days. Negligible.

## Data Model

### New Tables

**`wisdom_topics`** — extracted topic clusters
- id, name, slug, summary, message_count, contributor_count, last_active, created_at, updated_at

**`wisdom_items`** — individual knowledge entries
- id, topic_id, knowledge_type (enum), title, summary, source_links (JSON array of link IDs), source_messages (JSON array of message IDs), contributors (JSON array of names), confidence, created_at, updated_at

**`wisdom_recommendations`** — topic-to-topic connections
- id, from_topic_id, to_topic_id, strength (co-occurrence score), reason

### Relationship to Existing Data

Wisdom items reference links and messages by ID but don't duplicate content. The Wisdom page pulls the synthesized layer from these tables, drilling into existing links/messages for evidence.

Batch job watermark stored in existing `sync_state` table as `wisdom_last_run`.

## Chat Rail Integration

- Existing `/api/chat` endpoint stays mostly the same
- Rail passes current page as context parameter
- No per-page NLP scoping logic — just page awareness
- Thread persistence per scope in localStorage
