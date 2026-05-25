import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Pool } from "pg";

const queryMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
  })),
}));

vi.mock("@/lib/link-search", () => ({
  buildLinksFtsQuery: vi.fn(),
  normalizeLinkSearchTerms: vi.fn(() => []),
}));

vi.mock("@/lib/profile", () => ({
  buildSelfMentionRegex: vi.fn(() => /$a/),
  getSubjectAliases: vi.fn(() => []),
  getSubjectName: vi.fn(() => "Braydon"),
}));

vi.mock("@/lib/semantic", () => ({
  computeSemanticAnalytics: vi.fn(),
  searchHybridLinks: vi.fn(),
  searchHybridMessages: vi.fn(),
  searchThreadEvidence: vi.fn(),
}));

vi.mock("./semantic", () => ({
  computeSemanticAnalytics: vi.fn(),
  searchHybridLinks: vi.fn(),
  searchHybridMessages: vi.fn(),
  searchThreadEvidence: vi.fn(),
}));

const ORIGINAL_ENV = process.env;

describe("link queries", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    vi.mocked(Pool).mockClear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibez-links-"));
    dbPath = path.join(tempDir, "vibez.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE links (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        url_hash TEXT NOT NULL,
        title TEXT,
        category TEXT,
        relevance TEXT,
        shared_by TEXT,
        source_group TEXT,
        first_seen TEXT,
        last_seen TEXT,
        mention_count INTEGER,
        value_score REAL,
        report_date TEXT,
        authored_by TEXT,
        pinned INTEGER DEFAULT 0
      );
      CREATE TABLE raw_events (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        source_event_key TEXT NOT NULL,
        source_room_id TEXT NOT NULL,
        room_name TEXT NOT NULL,
        sender_key TEXT NOT NULL,
        sender_display_name TEXT NOT NULL,
        source_timestamp TEXT NOT NULL,
        body TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        raw_payload_json TEXT NOT NULL DEFAULT '{}',
        body_hash TEXT NOT NULL
      );
      CREATE TABLE raw_event_links (
        raw_event_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        host TEXT,
        position INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(`
      INSERT INTO links
        (id, url, url_hash, title, category, relevance, shared_by, source_group,
         first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
      VALUES
        (1, 'https://github.com/example/atlas', 'hash-1', 'example/atlas', 'repo',
         'Durable newspaper archive', 'Dana', 'Agents',
         '2026-05-17T10:00:00.000Z', '2026-05-17T11:00:00.000Z', 3, 9.5,
         '2026-05-17', 'Dana', 1),
        (2, 'https://example.com/notes', 'hash-2', 'Notes', 'article',
         'Background notes', 'Lee', 'Workflows',
         '2026-05-10T10:00:00.000Z', '2026-05-10T11:00:00.000Z', 1, 1.2,
        '2026-05-10', NULL, 0)
    `).run();
    db.prepare(`
      INSERT INTO raw_events
        (id, source, source_event_key, source_room_id, room_name, sender_key,
         sender_display_name, source_timestamp, body, body_hash)
      VALUES
        (1, 'beeper', 'room:event-1', 'room', 'Agents', 'dana', 'Dana',
         '2026-05-17T10:00:00.000Z', 'https://github.com/example/atlas', 'h1'),
        (2, 'beeper', 'room:event-2', 'room', 'Agents', 'lee', 'Lee',
         '2026-05-17T12:00:00.000Z', 'https://github.com/example/atlas', 'h2')
    `).run();
    db.prepare(`
      INSERT INTO raw_event_links (raw_event_id, url, normalized_url, host, position)
      VALUES
        (1, 'https://github.com/example/atlas', 'https://github.com/example/atlas', 'github.com', 0),
        (2, 'https://github.com/example/atlas', 'https://github.com/example/atlas', 'github.com', 0)
    `).run();
    db.close();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DB_PATH: dbPath,
      VIBEZ_DATABASE_URL: "",
      DATABASE_URL: "",
      VIBEZ_PGVECTOR_URL: "",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("reads links from SQLite when the dashboard has a local database path", async () => {
    const { getLinks } = await import("./db");

    const links = await getLinks({ limit: 5, sort: "trending" });

    expect(queryMock).not.toHaveBeenCalled();
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      id: 1,
      title: "example/atlas",
      source_group: "Agents",
      pinned: 1,
    });
  });

  test("filters links by first sharer instead of aggregate shared_by", async () => {
    const db = new Database(dbPath);
    db.prepare("UPDATE links SET shared_by = ? WHERE id = 1").run("Dana, Lee");
    db.close();
    const { getLinks } = await import("./db");

    const danaLinks = await getLinks({ sharedBy: "Dana", limit: 5 });
    const leeLinks = await getLinks({ sharedBy: "Lee", limit: 5 });

    expect(danaLinks.map((link) => link.id)).toContain(1);
    expect(leeLinks.map((link) => link.id)).not.toContain(1);
  });

  test("persists counted link stars per client", async () => {
    const { getLinkStars, setLinkStar } = await import("./db");

    await setLinkStar({ url: "https://github.com/example/atlas", clientId: "client-a", starred: true });
    await setLinkStar({ url: "https://github.com/example/atlas", clientId: "client-a", starred: true });
    await setLinkStar({ url: "https://github.com/example/atlas", clientId: "client-b", starred: true });

    const starred = await getLinkStars({
      urls: ["https://github.com/example/atlas"],
      clientId: "client-a",
    });

    expect(starred["https://github.com/example/atlas"]).toEqual({ count: 2, starred: true });

    await setLinkStar({ url: "https://github.com/example/atlas", clientId: "client-a", starred: false });
    const afterUnstar = await getLinkStars({
      urls: ["https://github.com/example/atlas"],
      clientId: "client-a",
    });

    expect(afterUnstar["https://github.com/example/atlas"]).toEqual({ count: 1, starred: false });
  });

  test("computes link stats from SQLite when no Postgres URL is configured", async () => {
    const { getLinkStats } = await import("./db");

    const stats = await getLinkStats({});

    expect(queryMock).not.toHaveBeenCalled();
    expect(stats.total).toBe(2);
    expect(stats.total_mentions).toBe(4);
    expect(stats.first_seen).toBe("2026-05-10T10:00:00.000Z");
    expect(stats.last_seen).toBe("2026-05-17T11:00:00.000Z");
    expect(stats.sources[0]).toEqual({ name: "github", count: 1 });
    expect(stats.categories).toContainEqual({ name: "repo", count: 1 });
    expect(stats.sharers).toContainEqual({ name: "Dana", count: 1 });
    expect(stats.authors).toContainEqual({ name: "Dana", count: 1 });
  });

  test("uses Postgres when a pgvector URL is configured", async () => {
    process.env = {
      ...process.env,
      VIBEZ_PGVECTOR_URL: "postgres://pgvector-host/railway",
    };
    queryMock
      .mockResolvedValueOnce({ rows: [{ raw_events: null, raw_event_links: null }] })
      .mockResolvedValueOnce({
        rows: [{ c: "7", mentions: "12", first_seen: "2025-04-07", last_seen: "2026-05-17" }],
      })
      .mockResolvedValueOnce({ rows: [{ category: "repo", cnt: "4" }] })
      .mockResolvedValueOnce({ rows: [{ shared_by: "Dana", cnt: "3" }] })
      .mockResolvedValueOnce({ rows: [{ url: "https://github.com/example/atlas" }] })
      .mockResolvedValueOnce({ rows: [{ authored_by: "Dana", cnt: "2" }] });

    const { getLinkStats } = await import("./db");
    const stats = await getLinkStats({});

    expect(queryMock).toHaveBeenCalled();
    expect(stats.total).toBe(7);
    expect(stats.total_mentions).toBe(12);
    expect(stats.sources).toEqual([{ name: "github", count: 1 }]);
    expect(stats.categories).toEqual([{ name: "repo", count: 4 }]);
  });

  test("keeps exact FTS link hits ahead of semantic results", async () => {
    process.env = {
      ...process.env,
      VIBEZ_PGVECTOR_URL: "postgres://pgvector-host/railway",
    };
    const linkSearch = await import("@/lib/link-search");
    const semantic = await import("@/lib/semantic");
    vi.mocked(linkSearch.buildLinksFtsQuery).mockReturnValue(`"taylor" OR "bugout"`);
    vi.mocked(linkSearch.normalizeLinkSearchTerms).mockReturnValue(["taylor", "bugout"]);
    vi.mocked(semantic.searchHybridLinks).mockResolvedValue([
      {
        id: 2,
        url: "https://github.com/example/other",
        url_hash: "other-hash",
        title: "Other repo",
        category: "repo",
        relevance: "Semantic neighbor",
        shared_by: "Manuel",
        source_group: "Show and Tell",
        first_seen: "2026-05-24T20:00:00.000Z",
        last_seen: "2026-05-24T20:00:00.000Z",
        mention_count: 1,
        value_score: 1,
        report_date: "2026-05-24",
        authored_by: null,
        pinned: 0,
      },
    ]);
    queryMock
      .mockResolvedValueOnce({ rows: [{ raw_events: null, raw_event_links: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          url: "https://github.com/taylorsatula/bugout",
          url_hash: "bugout-hash",
          title: "",
          category: null,
          relevance: "",
          shared_by: "Taylor - MIRA",
          source_group: "Show and Tell",
          first_seen: "2026-05-24T21:37:08.000Z",
          last_seen: "2026-05-24T21:37:08.000Z",
          mention_count: 1,
          value_score: 0,
          report_date: "2026-05-24",
          authored_by: null,
          pinned: 0,
        }],
      });

    const { searchLinks } = await import("./db");
    const links = await searchLinks({ query: "taylor bugout", limit: 10 });

    expect(links.map((link) => link.url)).toEqual([
      "https://github.com/taylorsatula/bugout",
      "https://github.com/example/other",
    ]);
    expect(semantic.searchHybridLinks).toHaveBeenCalledWith(expect.objectContaining({
      query: "taylor bugout",
    }));
    const ftsSql = String(queryMock.mock.calls[1][0]);
    expect(ftsSql).toContain("websearch_to_tsquery");
    expect(ftsSql).toContain(" OR (");
    expect(ftsSql).toContain("shared_by");
  });
});
