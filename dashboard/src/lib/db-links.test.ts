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
    db.close();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DB_PATH: dbPath,
      VIBEZ_DATABASE_URL: "",
      DATABASE_URL: "",
      VIBEZ_PGVECTOR_URL: "postgres://pgvector-host/railway",
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

  test("computes link stats from SQLite when Postgres only holds embeddings", async () => {
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
});
