import { describe, expect, test } from "vitest";

import { buildLinksFtsQuery } from "./link-search";

describe("buildLinksFtsQuery", () => {
  test("normalizes possessive terms for natural-language link queries", () => {
    expect(buildLinksFtsQuery("schuyler's iran site")).toBe(
      `"schuyler" OR "iran" OR "site"`,
    );
    expect(buildLinksFtsQuery("schuyler’s")).toBe(`"schuyler"`);
  });
});
