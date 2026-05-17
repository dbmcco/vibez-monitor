import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const getAtlasSnapshotMock = vi.fn();
const generateAtlasEditorialReportMock = vi.fn();
const readAtlasArtifactMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getAtlasSnapshot: getAtlasSnapshotMock,
}));

vi.mock("@/lib/atlas-report", () => ({
  generateAtlasEditorialReport: generateAtlasEditorialReportMock,
}));

vi.mock("@/lib/atlas-artifact", () => ({
  readAtlasArtifact: readAtlasArtifactMock,
}));

describe("GET /api/atlas", () => {
  const originalAllowLiveModel = process.env.VIBEZ_ATLAS_ALLOW_LIVE_MODEL;

  beforeEach(() => {
    getAtlasSnapshotMock.mockReset();
    generateAtlasEditorialReportMock.mockReset();
    readAtlasArtifactMock.mockReset();
    readAtlasArtifactMock.mockReturnValue(null);
    process.env.VIBEZ_ATLAS_ALLOW_LIVE_MODEL = originalAllowLiveModel;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env.VIBEZ_ATLAS_ALLOW_LIVE_MODEL = originalAllowLiveModel;
    vi.restoreAllMocks();
  });

  test("serves a local artifact without loading live data or calling the model", async () => {
    readAtlasArtifactMock.mockReturnValue({
      atlas: { overview: { messages: 2 } },
      editorial_report: { headline: "Local paper" },
      editorial_error: null,
      artifact: { generated_at: "2026-05-17T10:00:00Z", window_hours: 48, source: "local_ollama" },
    });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://test.local/api/atlas?hours=48"));
    const body = await response.json();

    expect(readAtlasArtifactMock).toHaveBeenCalledWith(48);
    expect(getAtlasSnapshotMock).not.toHaveBeenCalled();
    expect(generateAtlasEditorialReportMock).not.toHaveBeenCalled();
    expect(body.editorial_report).toEqual({ headline: "Local paper" });
    expect(body.artifact.source).toBe("local_ollama");
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

  test("does not call a live model in production without an artifact", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VIBEZ_ATLAS_ALLOW_LIVE_MODEL", "");
    getAtlasSnapshotMock.mockResolvedValue({ overview: { messages: 0 } });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://test.local/api/atlas?hours=48"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(generateAtlasEditorialReportMock).not.toHaveBeenCalled();
    expect(body).toEqual({
      atlas: { overview: { messages: 0 } },
      editorial_report: null,
      editorial_error: "atlas editorial artifact unavailable; run local Ollama artifact generation before deploy",
    });
  });
});
