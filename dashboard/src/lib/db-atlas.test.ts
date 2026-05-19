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

describe("getAtlasSnapshot", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    vi.mocked(Pool).mockClear();
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
            room_id: "agents",
            room_name: "Agents",
            sender_id: "@dana:example",
            sender_name: "Dana",
            body: "Agents need evaluated workflows.",
            timestamp: Date.parse("2026-05-16T12:00:00Z"),
            raw_event: "{}",
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
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "m1",
            room_id: "agents",
            room_name: "Agents",
            sender_id: "@dana:example",
            sender_name: "Dana",
            body: "Agents need evaluated workflows.",
            timestamp: Date.now() - 60 * 60 * 1000,
            raw_event: "{}",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            person_key: "@dana:example",
            first_ts: Date.now() - 60 * 60 * 1000,
          },
        ],
      });

    const { getAtlasSnapshot } = await import("./db");
    const atlas = await getAtlasSnapshot({ windowHours: 48 });

    expect(queryMock).toHaveBeenCalledTimes(7);
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
    expect(atlas.people.top_contributors[0]).toMatchObject({
      name: "Dana",
      message_count_7d: 1,
    });
    expect(atlas.people.new_faces[0].detection_reasons).toContain("first_seen");
  });

  test("uses the pgvector URL as the dashboard Postgres fallback", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: "",
      VIBEZ_DATABASE_URL: "",
      VIBEZ_PGVECTOR_URL: "postgres://pgvector-host/railway",
    };

    await import("./db");

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgres://pgvector-host/railway",
    }));
  });

  test("falls back to all rooms when pgvector database has no sync_state table", async () => {
    const error = new Error("relation \"sync_state\" does not exist") as Error & { code: string };
    error.code = "42P01";
    queryMock.mockRejectedValueOnce(error);

    const { getCurrentRoomScope } = await import("./db");

    await expect(getCurrentRoomScope()).resolves.toEqual({
      mode: "all",
      activeGroupIds: [],
      activeGroupNames: [],
      excludedGroups: [],
    });
  });

  test("buckets Postgres bigint timestamp strings in Stats timelines", async () => {
    const oldSeedTs = Date.parse("2024-02-18T12:00:00Z");
    const firstTs = Date.parse("2026-05-16T12:00:00Z");
    const secondTs = Date.parse("2026-05-16T12:10:00Z");
    const thirdTs = Date.parse("2026-05-17T12:00:00Z");
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            timestamp: String(oldSeedTs),
            sender_id: "@seed:example",
            sender_name: "Seed",
            room_name: "Agents",
            body: "A pre-archive seed row should not drive Stats history.",
            topics: JSON.stringify(["seed"]),
            relevance_score: 1,
          },
          {
            timestamp: String(firstTs),
            sender_id: "@dana:example",
            sender_name: "Dana",
            room_name: "Agents",
            body: "Lee, can you review agent workflows?",
            topics: JSON.stringify(["agents"]),
            relevance_score: 7,
          },
          {
            timestamp: String(secondTs),
            sender_id: "@lee:example",
            sender_name: "Lee",
            room_name: "Agents",
            body: "Thanks Dana, I can review this workflow.",
            topics: JSON.stringify(["agents", "workflows"]),
            relevance_score: 8,
          },
          {
            timestamp: String(thirdTs),
            sender_id: "+16175551212",
            sender_name: "+1 (617) 555-1212",
            room_name: "Agents",
            body: "I can help with agents too.",
            topics: JSON.stringify(["agents"]),
            relevance_score: 6,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { timestamp: String(oldSeedTs), topics: JSON.stringify(["seed"]) },
          { timestamp: String(firstTs), topics: JSON.stringify(["agents"]) },
          { timestamp: String(secondTs), topics: JSON.stringify(["agents", "workflows"]) },
          { timestamp: String(thirdTs), topics: JSON.stringify(["agents"]) },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { timestamp: String(oldSeedTs), sender_id: "@seed:example", sender_name: "Seed" },
          { timestamp: String(firstTs), sender_id: "@dana:example", sender_name: "Dana" },
          { timestamp: String(secondTs), sender_id: "@lee:example", sender_name: "Lee" },
          { timestamp: String(thirdTs), sender_id: "+16175551212", sender_name: "+1 (617) 555-1212" },
        ],
      });

    const { getStatsDashboard } = await import("./db");
    const stats = await getStatsDashboard(null);
    const nonzeroDays = stats.timeline.filter((day) => day.count > 0);

    expect(nonzeroDays).toEqual([
      { date: "2026-05-16", count: 2 },
      { date: "2026-05-17", count: 1 },
    ]);
    expect(stats.totals.users).toBe(3);
    expect(stats.history).toMatchObject({ first_seen: "2026-05-16", messages: 3, members_observed: 3 });
    expect(stats.network.relationships.nodes.find((node) => node.id === "+1 (617) 555-1212")).toMatchObject({
      identity_status: "phone",
    });
    expect(stats.network.relationships.nodes.find((node) => node.id === "Lee")?.bridge_score).toBeGreaterThan(0);
    expect(stats.network.relationships.edges.find((edge) =>
      (edge.source === "Lee" && edge.target === "Dana") ||
      (edge.source === "Dana" && edge.target === "Lee"),
    )).toMatchObject({
      evidence_label: expect.stringMatching(/reply|mention/),
      confidence: expect.any(Number),
    });
  });
});
