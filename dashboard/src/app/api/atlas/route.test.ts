import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const getAtlasSnapshotMock = vi.fn();
const generateAtlasEditorialReportMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getAtlasSnapshot: getAtlasSnapshotMock,
}));

vi.mock("@/lib/atlas-report", () => ({
  generateAtlasEditorialReport: generateAtlasEditorialReportMock,
}));

describe("GET /api/atlas", () => {
  beforeEach(() => {
    getAtlasSnapshotMock.mockReset();
    generateAtlasEditorialReportMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bounds the requested window before loading the snapshot", async () => {
    getAtlasSnapshotMock.mockResolvedValue({ overview: { messages: 0 } });
    generateAtlasEditorialReportMock.mockResolvedValue({ headline: "Readable report" });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://test.local/api/atlas?hours=999"));
    const body = await response.json();

    expect(getAtlasSnapshotMock).toHaveBeenCalledWith({ windowHours: 168 });
    expect(generateAtlasEditorialReportMock).toHaveBeenCalledWith({ overview: { messages: 0 } });
    expect(body).toEqual({
      atlas: { overview: { messages: 0 } },
      editorial_report: { headline: "Readable report" },
      editorial_error: null,
    });
  });

  test("uses the default 48 hour window for invalid input", async () => {
    getAtlasSnapshotMock.mockResolvedValue({ overview: { messages: 0 } });
    generateAtlasEditorialReportMock.mockResolvedValue({ headline: "Readable report" });

    const { GET } = await import("./route");
    await GET(new NextRequest("http://test.local/api/atlas?hours=nope"));

    expect(getAtlasSnapshotMock).toHaveBeenLastCalledWith({ windowHours: 48 });
  });

  test("returns an explicit null report when model analysis fails", async () => {
    getAtlasSnapshotMock.mockResolvedValue({ overview: { messages: 0 } });
    generateAtlasEditorialReportMock.mockRejectedValue(new Error("model unavailable"));

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://test.local/api/atlas?hours=48"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      atlas: { overview: { messages: 0 } },
      editorial_report: null,
      editorial_error: "model unavailable",
    });
  });
});
