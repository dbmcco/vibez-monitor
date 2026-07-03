import { describe, expect, test } from "vitest";

import { cleanAtlasReaderText } from "./atlas-text";

describe("cleanAtlasReaderText", () => {
  test("removes raw Atlas citation refs from reader prose", () => {
    expect(
      cleanAtlasReaderText(
        "The pattern is real (vibez:message:beeper-123, vibez:link:7945). The work remains.",
      ),
    ).toBe("The pattern is real. The work remains.");
  });

  test("keeps normal prose cleanup behavior", () => {
    expect(cleanAtlasReaderText("<p>Useful &amp; readable **copy**</p>")).toBe("Useful & readable copy");
  });
});
