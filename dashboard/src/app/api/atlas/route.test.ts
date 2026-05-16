import { describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const getAtlasSnapshotMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getAtlasSnapshot: getAtlasSnapshotMock,
}));

describe("GET /api/atlas", () => {
  test("bounds the requested window before loading the snapshot", async () => {
    getAtlasSnapshotMock.mockResolvedValue({ overview: { messages: 0 } });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://test.local/api/atlas?hours=999"));
    const body = await response.json();

    expect(getAtlasSnapshotMock).toHaveBeenCalledWith({ windowHours: 168 });
    expect(body).toEqual({ atlas: { overview: { messages: 0 } } });
  });

  test("uses the default 48 hour window for invalid input", async () => {
    getAtlasSnapshotMock.mockResolvedValue({ overview: { messages: 0 } });

    const { GET } = await import("./route");
    await GET(new NextRequest("http://test.local/api/atlas?hours=nope"));

    expect(getAtlasSnapshotMock).toHaveBeenLastCalledWith({ windowHours: 48 });
  });
});
