import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getRoute, loadRoutes } from "./model-router";

describe("model-router", () => {
  test("loads the shared routing manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-"));
    const manifestPath = path.join(dir, "model-routing.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        routes: {
          "embedding.semantic": {
            provider: "openai",
            model: "text-embedding-3-small",
            mode: "embedding",
            max_tokens: 0,
            temperature: 0,
            timeout_ms: 30000,
            dimensions: 256,
          },
          "chat.interactive": {
            provider: "openai",
            model: "gpt-5.1",
            mode: "text",
            max_tokens: 1024,
            temperature: 0.2,
            timeout_ms: 60000,
          },
        },
      }),
    );

    const routes = loadRoutes(manifestPath);

    expect(routes["chat.interactive"]).toMatchObject({
      provider: "openai",
      model: "gpt-5.1",
      mode: "text",
    });
    expect(routes["embedding.semantic"]).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      mode: "embedding",
      dimensions: 256,
    });
  });

  test("throws on unknown task ids", () => {
    expect(() => getRoute("dashboard.catchup", {})).toThrow(
      "unknown model route: dashboard.catchup",
    );
  });
});
