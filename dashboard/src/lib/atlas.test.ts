import { describe, expect, test } from "vitest";

import { buildAtlasSnapshotFromRows } from "./atlas";

const baseTs = Date.parse("2026-05-16T12:00:00Z");

describe("buildAtlasSnapshotFromRows", () => {
  test("groups recent messages into channel-topic matrix cells with citation refs", () => {
    const atlas = buildAtlasSnapshotFromRows({
      generatedAt: "2026-05-16T13:00:00Z",
      windowStart: "2026-05-14T13:00:00Z",
      windowEnd: "2026-05-16T13:00:00Z",
      messages: [
        {
          id: "m1",
          room_name: "Agents",
          sender_name: "Dana",
          body: "The evaluation loop is the key blocker for agent work.",
          timestamp: baseTs,
          relevance_score: 9,
          topics: JSON.stringify(["evals", "agents"]),
          alert_level: "normal",
        },
        {
          id: "m2",
          room_name: "Agents",
          sender_name: "Lee",
          body: "Can we map the agent workflow back to citations?",
          timestamp: baseTs - 10_000,
          relevance_score: 7,
          topics: JSON.stringify(["agents"]),
          alert_level: "hot",
        },
        {
          id: "m3",
          room_name: "Security",
          sender_name: "Mira",
          body: "Security concerns need a separate review path.",
          timestamp: baseTs - 20_000,
          relevance_score: 8,
          topics: JSON.stringify(["security"]),
          alert_level: "normal",
        },
      ],
      links: [],
    });

    expect(atlas.overview.messages).toBe(3);
    expect(atlas.channels[0]).toMatchObject({
      name: "Agents",
      message_count: 2,
    });
    expect(atlas.topics.map((topic) => topic.name)).toContain("agents");
    expect(atlas.matrix).toContainEqual(
      expect.objectContaining({
        channel: "Agents",
        topic: "agents",
        message_count: 2,
        citation_refs: ["vibez:message:m1", "vibez:message:m2"],
      }),
    );
    expect(atlas.citations["vibez:message:m1"]).toMatchObject({
      type: "message",
      id: "m1",
      channel: "Agents",
      sender: "Dana",
    });
  });

  test("includes recent links and diagnostic concern candidates", () => {
    const atlas = buildAtlasSnapshotFromRows({
      generatedAt: "2026-05-16T13:00:00Z",
      windowStart: "2026-05-14T13:00:00Z",
      windowEnd: "2026-05-16T13:00:00Z",
      messages: [
        {
          id: "m4",
          room_name: "Planning",
          sender_name: "Sam",
          body: "I am worried this launch is blocked without source evidence?",
          timestamp: baseTs,
          relevance_score: 8,
          topics: null,
          alert_level: "hot",
        },
      ],
      links: [
        {
          id: 11,
          url: "https://example.com/report",
          title: "Launch report",
          category: "article",
          relevance: "Evidence for launch planning",
          shared_by: "Sam",
          source_group: "Planning",
          last_seen: "2026-05-16T11:00:00Z",
          value_score: 3.2,
        },
      ],
    });

    expect(atlas.links[0]).toMatchObject({
      ref: "vibez:link:11",
      title: "Launch report",
      url: "https://example.com/report",
    });
    expect(atlas.citations["vibez:link:11"]).toMatchObject({
      type: "link",
      id: "11",
      title: "Launch report",
    });
    expect(atlas.concerns).toContainEqual(
      expect.objectContaining({
        kind: "hot_alert",
        citation_refs: ["vibez:message:m4"],
      }),
    );
    expect(atlas.concerns).toContainEqual(
      expect.objectContaining({
        kind: "under_covered",
      }),
    );
  });
});
