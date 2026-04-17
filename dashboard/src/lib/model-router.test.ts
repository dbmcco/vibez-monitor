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
  });

  test("throws on unknown task ids", () => {
    expect(() => getRoute("dashboard.catchup", {})).toThrow(
      "unknown model route: dashboard.catchup",
    );
  });
});
