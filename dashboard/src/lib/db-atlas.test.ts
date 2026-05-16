import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

describe("getAtlasSnapshot", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_EXCLUDED_GROUPS: "",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test("loads recent messages and links into the Atlas view model", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "m1",
            room_name: "Agents",
            sender_name: "Dana",
            body: "Agents need evaluated workflows.",
            timestamp: Date.parse("2026-05-16T12:00:00Z"),
            relevance_score: 8,
            topics: JSON.stringify(["agents"]),
            alert_level: "normal",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 3,
            url: "https://example.com/agents",
            title: "Agent workflow",
            category: "repo",
            relevance: "Shared as evidence",
            shared_by: "Dana",
            source_group: "Agents",
            last_seen: "2026-05-16T12:05:00Z",
            value_score: 2.4,
          },
        ],
      });

    const { getAtlasSnapshot } = await import("./db");
    const atlas = await getAtlasSnapshot({ windowHours: 48 });

    expect(queryMock).toHaveBeenCalledTimes(5);
    expect(atlas.overview.messages).toBe(1);
    expect(atlas.matrix[0]).toMatchObject({
      channel: "Agents",
      topic: "agents",
      citation_refs: ["vibez:message:m1"],
    });
    expect(atlas.links[0]).toMatchObject({
      ref: "vibez:link:3",
      title: "Agent workflow",
    });
  });
});
