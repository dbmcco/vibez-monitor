import { describe, expect, test } from "vitest";

import {
  atlasArticleHref,
  isRenderableArticleImageUrl,
  parseAtlasWindowHours,
} from "./atlas-ui";

describe("atlas UI helpers", () => {
  test("preserves the selected evidence window in article links", () => {
    expect(atlasArticleHref("2026-05-17", "weekly-story", 168)).toBe(
      "/atlas/issues/2026-05-17/weekly-story?hours=168",
    );
  });

  test("keeps article pages on supported evidence windows", () => {
    expect(parseAtlasWindowHours("168")).toBe(168);
    expect(parseAtlasWindowHours("48")).toBe(48);
    expect(parseAtlasWindowHours("bogus")).toBe(48);
    expect(parseAtlasWindowHours(null)).toBe(48);
  });

  test("falls back from unusable article image URLs", () => {
    expect(isRenderableArticleImageUrl("https://example.com/image.png")).toBe(true);
    expect(isRenderableArticleImageUrl("/atlas/image.png")).toBe(true);
    expect(isRenderableArticleImageUrl("data:image/svg+xml,abc")).toBe(true);
    expect(isRenderableArticleImageUrl("not a url")).toBe(false);
    expect(isRenderableArticleImageUrl("javascript:alert(1)")).toBe(false);
    expect(isRenderableArticleImageUrl(undefined)).toBe(false);
  });
});
