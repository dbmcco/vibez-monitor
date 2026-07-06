import { describe, expect, test } from "vitest";

import { buildAtGlanceItems } from "./BriefingView";

describe("buildAtGlanceItems", () => {
  test("keeps overview narrative text complete instead of ellipsizing it", () => {
    const memo =
      "Paragraph one frames the main theme. Paragraph two explains why the theme matters. Paragraph three names the shift in the conversation. Paragraph four calls out the evidence trail. Paragraph five closes with what to watch next.";

    const items = buildAtGlanceItems(null, {}, [], memo, null, "", [], {});
    const narrative = items.find((item) => item.title === "Daily Narrative");

    expect(narrative?.detail).toBe(memo);
    expect(narrative?.detail).not.toContain("…");
  });
});
