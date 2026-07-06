import { describe, expect, test, vi } from "vitest";

import { buildCatchupPrompt, isCatchupCacheUsable } from "./catchup";

vi.mock("@/lib/model-router", () => ({
  generateText: vi.fn(),
}));

describe("buildCatchupPrompt", () => {
  test("asks for a five paragraph week-in-review plus branching theme map", () => {
    const prompt = buildCatchupPrompt(
      [
        {
          report_date: "2026-05-04",
          daily_memo: "Agents became the dominant thread.",
          conversation_arcs: JSON.stringify([
            { title: "Agent workflow discipline", participants: ["Dana", "Lee"] },
          ]),
          trends: JSON.stringify({ emerging: ["agent-orchestration"] }),
          stats: "[]",
        },
      ],
      "2026-05-04",
      "2026-05-10",
    );

    expect(prompt).toContain('"week_in_review"');
    expect(prompt).toContain('"paragraphs": ["<paragraph 1>"');
    expect(prompt).toContain('"theme_map"');
    expect(prompt).toContain('"convergences"');
    expect(prompt).toContain("Exactly 5 paragraphs");
  });
});

describe("isCatchupCacheUsable", () => {
  test("rejects cached results that predate the week-in-review field", () => {
    expect(
      isCatchupCacheUsable({
        catchup_memo: "Old cache",
        conversation_arcs: [],
        themes: [],
        trends: { emerging: [], fading: [], shifts: "" },
        links: [],
        people_activity: [],
        unresolved_threads: [],
        hot_on_return: [],
      }),
    ).toBe(false);
  });

  test("accepts cached results with five paragraphs and a theme map", () => {
    expect(
      isCatchupCacheUsable({
        catchup_memo: "Current cache",
        week_in_review: {
          title: "Fast theme branching",
          paragraphs: ["one", "two", "three", "four", "five"],
          theme_map: {
            branches: [
              {
                theme: "agent-workflows",
                timeline: "built through the week",
                drivers: ["demos"],
                evidence: ["daily memo"],
                people: ["Dana"],
                tension: "speed versus discipline",
                implication: "more explicit operating patterns",
              },
            ],
            convergences: [
              {
                themes: ["agent-workflows", "evaluation"],
                meaning: "execution quality became the shared constraint",
              },
            ],
          },
        },
        conversation_arcs: [],
        themes: [],
        trends: { emerging: [], fading: [], shifts: "" },
        links: [],
        people_activity: [],
        unresolved_threads: [],
        hot_on_return: [],
      }),
    ).toBe(true);
  });
});
