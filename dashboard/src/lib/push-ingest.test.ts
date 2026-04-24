import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import { applyPgvectorPayload, applyPushPayload } from "./push-ingest";

const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

function openPushTestDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-ingest-"));
  tempDirs.push(dir);

  const db = new Database(path.join(dir, "vibez.db"));
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_name TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      raw_event TEXT NOT NULL
    );
    CREATE TABLE classifications (
      message_id TEXT PRIMARY KEY REFERENCES messages(id),
      relevance_score INTEGER NOT NULL DEFAULT 0,
      topics TEXT NOT NULL DEFAULT '[]',
      entities TEXT NOT NULL DEFAULT '[]',
      contribution_flag INTEGER NOT NULL DEFAULT 0,
      contribution_themes TEXT NOT NULL DEFAULT '[]',
      contribution_hint TEXT,
      alert_level TEXT NOT NULL DEFAULT 'none'
    );
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      category TEXT,
      relevance TEXT,
      shared_by TEXT,
      source_group TEXT,
      first_seen TEXT,
      last_seen TEXT,
      mention_count INTEGER DEFAULT 1,
      value_score REAL DEFAULT 0,
      report_date TEXT,
      authored_by TEXT,
      pinned INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_links_url_hash ON links (url_hash);
    CREATE VIRTUAL TABLE links_fts USING fts5(title, relevance, category, url);
    CREATE TABLE daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT UNIQUE NOT NULL,
      briefing_md TEXT,
      briefing_json TEXT,
      contributions TEXT,
      trends TEXT,
      daily_memo TEXT,
      conversation_arcs TEXT,
      stats TEXT,
      generated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE wisdom_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      summary TEXT,
      message_count INTEGER DEFAULT 0,
      contributor_count INTEGER DEFAULT 0,
      last_active TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE wisdom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
      knowledge_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      source_links TEXT DEFAULT '[]',
      source_messages TEXT DEFAULT '[]',
      contributors TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.5,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE wisdom_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
      to_topic_id INTEGER NOT NULL REFERENCES wisdom_topics(id),
      strength REAL DEFAULT 0,
      reason TEXT
    );
  `);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("applyPushPayload", () => {
  test("writes records and filters sync state to transport-safe keys", () => {
    const db = openPushTestDb();

    applyPushPayload(db, {
      records: [
        {
          message: {
            id: "m1",
            room_id: "room-1",
            room_name: "Show and Tell",
            sender_id: "user-1",
            sender_name: "Alice",
            body: "hello world",
            timestamp: 1776120000000,
            raw_event: "{}",
          },
          classification: {
            relevance_score: 8,
            topics: ["agents"],
            entities: ["Alice"],
            contribution_flag: true,
            contribution_themes: ["demo"],
            contribution_hint: "worth saving",
            alert_level: "digest",
          },
        },
      ],
      sync_state: {
        wisdom_last_run: "1776160800000",
        "google_groups_uid_cursor:INBOX": "12345",
      },
    });

    const message = db.prepare("SELECT room_name, sender_name FROM messages WHERE id = ?").get("m1");
    const classification = db.prepare(
      "SELECT relevance_score, alert_level FROM classifications WHERE message_id = ?"
    ).get("m1");
    const keys = db.prepare("SELECT key FROM sync_state ORDER BY key").all() as Array<{ key: string }>;

    expect(message).toMatchObject({ room_name: "Show and Tell", sender_name: "Alice" });
    expect(classification).toMatchObject({ relevance_score: 8, alert_level: "digest" });
    expect(keys).toEqual([{ key: "wisdom_last_run" }]);
  });

  test("upserts links by url_hash and syncs links_fts", () => {
    const db = openPushTestDb();

    applyPushPayload(db, {
      links: [
        {
          url: "https://example.com/a",
          url_hash: "hash-a",
          title: "Example A",
          category: "repo",
          relevance: "Useful repo",
          shared_by: "Alice",
          source_group: "Show and Tell",
          first_seen: "2026-04-14T10:00:00+00:00",
          last_seen: "2026-04-14T10:05:00+00:00",
          mention_count: 2,
          value_score: 1.5,
          report_date: "2026-04-14",
          authored_by: "Alice",
          pinned: 1,
        },
      ],
    });

    const row = db.prepare("SELECT url, title, mention_count FROM links WHERE url_hash = ?").get("hash-a");
    const ftsRow = db.prepare(
      "SELECT url FROM links_fts WHERE rowid = (SELECT id FROM links WHERE url_hash = ?)"
    ).get("hash-a");

    expect(row).toMatchObject({
      url: "https://example.com/a",
      title: "Example A",
      mention_count: 2,
    });
    expect(ftsRow).toMatchObject({ url: "https://example.com/a" });
  });

  test("upserts daily reports by report_date", () => {
    const db = openPushTestDb();
    db.prepare("INSERT INTO daily_reports (report_date, briefing_md) VALUES (?, ?)").run(
      "2026-04-14",
      "# Old",
    );

    applyPushPayload(db, {
      daily_reports: [
        {
          report_date: "2026-04-14",
          briefing_md: "# New",
          briefing_json: "[{\"title\":\"T1\"}]",
          contributions: "[]",
          trends: "{}",
          daily_memo: "memo",
          conversation_arcs: "[]",
          stats: "{}",
          generated_at: "2026-04-14T11:00:00+00:00",
        },
      ],
    });

    const row = db.prepare(
      "SELECT briefing_md, generated_at FROM daily_reports WHERE report_date = ?"
    ).get("2026-04-14");

    expect(row).toMatchObject({
      briefing_md: "# New",
      generated_at: "2026-04-14T11:00:00+00:00",
    });
  });

  test("upserts wisdom rows by topic slug rather than local ids", () => {
    const db = openPushTestDb();

    applyPushPayload(db, {
      wisdom_topics: [
        {
          name: "Agent Reviews",
          slug: "agent-reviews",
          summary: "Review loops matter",
          message_count: 3,
          contributor_count: 2,
          last_active: "2026-04-14T10:00:00+00:00",
          created_at: "2026-04-14T10:00:00+00:00",
          updated_at: "2026-04-14T10:05:00+00:00",
        },
      ],
      wisdom_items: [
        {
          topic_slug: "agent-reviews",
          knowledge_type: "best_practices",
          title: "Review loops catch regressions",
          summary: "Use multiple review passes.",
          source_links: "[\"https://example.com/a\"]",
          source_messages: "[\"m1\"]",
          contributors: "[\"Alice\"]",
          confidence: 0.8,
          created_at: "2026-04-14T10:00:00+00:00",
          updated_at: "2026-04-14T10:05:00+00:00",
        },
      ],
      wisdom_recommendations: [
        {
          from_topic_slug: "agent-reviews",
          to_topic_slug: "agent-reviews",
          strength: 0.5,
          reason: "Shared contributors: Alice",
        },
      ],
    });

    const item = db.prepare(
      `SELECT wi.title, wt.slug AS topic_slug
       FROM wisdom_items wi
       JOIN wisdom_topics wt ON wt.id = wi.topic_id`
    ).get();
    const rec = db.prepare(
      `SELECT source.slug AS from_slug, target.slug AS to_slug, wr.strength
       FROM wisdom_recommendations wr
       JOIN wisdom_topics source ON source.id = wr.from_topic_id
       JOIN wisdom_topics target ON target.id = wr.to_topic_id`
    ).get();

    expect(item).toMatchObject({
      title: "Review loops catch regressions",
      topic_slug: "agent-reviews",
    });
    expect(rec).toMatchObject({
      from_slug: "agent-reviews",
      to_slug: "agent-reviews",
      strength: 0.5,
    });
  });

  test("writes precomputed embedding payloads through the pgvector writer", async () => {
    const writeMessageEmbeddings = vi.fn(async (rows) => rows.length);
    const writeLinkEmbeddings = vi.fn(async (rows) => rows.length);

    const result = await applyPgvectorPayload(
      {
        message_embeddings: [
          {
            message_id: "m1",
            room_id: "room-1",
            room_name: "Show and Tell",
            sender_id: "user-1",
            sender_name: "Alice",
            body: "hello world",
            timestamp: 1776120000000,
            relevance_score: 8,
            topics: "[\"agents\"]",
            entities: "[\"Alice\"]",
            contribution_flag: 1,
            contribution_themes: "[\"demo\"]",
            contribution_hint: "worth saving",
            alert_level: "digest",
            embedding: "[0.1,0.2]",
          },
        ],
        link_embeddings: [
          {
            link_id: 7,
            url: "https://example.com/a",
            url_hash: "hash-a",
            title: "Example A",
            category: "repo",
            relevance: "Useful repo",
            shared_by: "Alice",
            source_group: "Show and Tell",
            first_seen: "2026-04-14T10:00:00+00:00",
            last_seen: "2026-04-14T10:05:00+00:00",
            mention_count: 2,
            value_score: 1.5,
            report_date: "2026-04-14",
            authored_by: "Alice",
            pinned: 1,
            embedding: "[0.3,0.4]",
          },
        ],
      },
      {
        writeMessageEmbeddings,
        writeLinkEmbeddings,
      },
    );

    expect(writeMessageEmbeddings).toHaveBeenCalledTimes(1);
    expect(writeLinkEmbeddings).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      message_embeddings_written: 1,
      link_embeddings_written: 1,
    });
  });
});
