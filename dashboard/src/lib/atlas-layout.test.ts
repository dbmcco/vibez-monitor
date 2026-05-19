import { describe, expect, test } from "vitest";

import { splitFrontPageArticles } from "./atlas-layout";

describe("splitFrontPageArticles", () => {
  test("places one lead in the center and two secondary stories in each side lane", () => {
    const articles = [
      { role: "lead" as const, slug: "lead" },
      { role: "secondary" as const, slug: "left-1" },
      { role: "secondary" as const, slug: "left-2" },
      { role: "secondary" as const, slug: "right-1" },
      { role: "secondary" as const, slug: "right-2" },
      { role: "secondary" as const, slug: "overflow" },
    ];

    const split = splitFrontPageArticles(articles);

    expect(split.lead?.slug).toBe("lead");
    expect(split.left.map((article) => article.slug)).toEqual(["left-1", "left-2"]);
    expect(split.right.map((article) => article.slug)).toEqual(["right-1", "right-2"]);
    expect(split.overflow.map((article) => article.slug)).toEqual(["overflow"]);
  });

  test("uses the first article as lead when the model does not mark one", () => {
    const articles = [
      { role: "secondary" as const, slug: "first" },
      { role: "secondary" as const, slug: "second" },
    ];

    const split = splitFrontPageArticles(articles);

    expect(split.lead?.slug).toBe("first");
    expect(split.left.map((article) => article.slug)).toEqual(["second"]);
  });
});
