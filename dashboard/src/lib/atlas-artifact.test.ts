import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
  })),
}));

const ORIGINAL_ENV = process.env;

describe("listAtlasEditions", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DATABASE_URL: "postgres://atlas-editions",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test("lists durable editions newest first for the requested window", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            edition_date: "2026-05-18",
            edition_type: "daily",
            window_hours: 48,
            publication_time: "2026-05-18T13:00:00Z",
            title: "The Monday Paper",
            subtitle: "The week starts with receipts.",
            edition_label: "Daily Edition",
          },
        ],
      });

    const { listAtlasEditions } = await import("./atlas-artifact");
    const editions = await listAtlasEditions({ windowHours: 48 });

    expect(queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("ORDER BY publication_time DESC"),
      [48, "daily", 14],
    );
    expect(editions).toEqual([
      {
        date: "2026-05-18",
        type: "daily",
        window_hours: 48,
        publication_time: "2026-05-18T13:00:00Z",
        title: "The Monday Paper",
        subtitle: "The week starts with receipts.",
        edition_label: "Daily Edition",
        href: "/atlas/editions/2026-05-18?hours=48",
      },
    ]);
  });
});
