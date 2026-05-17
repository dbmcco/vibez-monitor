import fs from "node:fs";
import path from "node:path";

import type { AtlasSnapshot } from "./atlas";
import type { AtlasEditorialReport } from "./atlas-report";

export interface AtlasArtifactPayload {
  atlas: AtlasSnapshot;
  editorial_report: AtlasEditorialReport;
  editorial_error: null;
  artifact: {
    generated_at: string;
    window_hours: number;
    source: "configured_model_route";
  };
}

export function atlasArtifactPath(windowHours: number): string {
  const configured = process.env.VIBEZ_ATLAS_ARTIFACT_PATH;
  if (configured) return configured;
  return path.join(defaultArtifactRoot(), "atlas", `atlas-${windowHours}.json`);
}

function defaultArtifactRoot(): string {
  const cwd = /* turbopackIgnore: true */ process.cwd();
  if (path.basename(cwd) === "dashboard") {
    return path.join(cwd, ".generated");
  }
  const dashboardDir = path.join(cwd, "dashboard");
  if (fs.existsSync(path.join(dashboardDir, "package.json"))) {
    return path.join(dashboardDir, ".generated");
  }
  return path.join(cwd, ".generated");
}

export function readAtlasArtifact(windowHours: number): AtlasArtifactPayload | null {
  const artifactPath = atlasArtifactPath(windowHours);
  if (!fs.existsSync(artifactPath)) return null;
  const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as AtlasArtifactPayload;
  if (payload.artifact?.window_hours !== windowHours) return null;
  if (!payload.atlas || !payload.editorial_report) return null;
  return payload;
}

export function writeAtlasArtifact({
  windowHours,
  atlas,
  editorialReport,
}: {
  windowHours: number;
  atlas: AtlasSnapshot;
  editorialReport: AtlasEditorialReport;
}): string {
  const artifactPath = atlasArtifactPath(windowHours);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const payload: AtlasArtifactPayload = {
    atlas,
    editorial_report: editorialReport,
    editorial_error: null,
    artifact: {
      generated_at: new Date().toISOString(),
      window_hours: windowHours,
      source: "configured_model_route",
    },
  };
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
  return artifactPath;
}
