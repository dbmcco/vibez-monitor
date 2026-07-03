import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const applyBeeperBatchPayloadMock = vi.fn();

vi.mock("@/lib/push-ingest", () => ({
  applyBeeperBatchPayload: applyBeeperBatchPayloadMock,
}));

describe("POST /api/ingest/beeper/batch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VIBEZ_CAPTURE_API_KEY", "capture-secret");
    applyBeeperBatchPayloadMock.mockReset();
    applyBeeperBatchPayloadMock.mockResolvedValue({
      ok: true,
      source: "beeper",
      batch_key: "batch-1",
      record_count: 2,
      inserted_count: 1,
      deduped_count: 1,
    });
  });

  test("rejects requests without the capture token", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://test.local/api/ingest/beeper/batch", {
      method: "POST",
      body: JSON.stringify({ batch_key: "batch-1", events: [] }),
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, error: "Unauthorized." });
    expect(applyBeeperBatchPayloadMock).not.toHaveBeenCalled();
  });

  test("persists an authenticated Beeper batch", async () => {
    const payload = {
      batch_key: "batch-1",
      events: [
        {
          source_event_key: "room-1:event-1",
          source_room_id: "room-1",
          room_name: "Agent Harnesses",
          sender_key: "member-1",
          sender_display_name: "Dana",
          source_timestamp: "2026-05-19T08:30:00.000Z",
          body: "Worth saving.",
        },
      ],
    };

    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://test.local/api/ingest/beeper/batch", {
      method: "POST",
      headers: { "x-vibez-capture-key": "capture-secret" },
      body: JSON.stringify(payload),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(applyBeeperBatchPayloadMock).toHaveBeenCalledWith({
      source: "beeper",
      ...payload,
    });
    expect(body).toEqual({
      ok: true,
      source: "beeper",
      batch_key: "batch-1",
      record_count: 2,
      inserted_count: 1,
      deduped_count: 1,
    });
  });
});
