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
  return atlasArtifactCandidates(windowHours)[0];
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

function atlasArtifactCandidates(windowHours: number): string[] {
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const filename = path.join("atlas", `atlas-${windowHours}.json`);
  const roots = [
    defaultArtifactRoot(),
    path.join(cwd, "generated"),
    path.join(cwd, "dashboard", ".generated"),
    path.join(cwd, "dashboard", "generated"),
  ];
  return Array.from(new Set(roots.map((root) => path.join(root, filename))));
}

export function atlasGeneratedAssetCandidates(relativePath: string): string[] {
  const safePath = relativePath
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
  if (!safePath) return [];
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const roots = [
    defaultArtifactRoot(),
    path.join(cwd, "generated"),
    path.join(cwd, "dashboard", ".generated"),
    path.join(cwd, "dashboard", "generated"),
  ];
  return Array.from(new Set(roots.map((root) => path.join(root, safePath))));
}

export function readAtlasGeneratedAsset(relativePath: string): { data: Buffer; contentType: string } | null {
  const assetPath = atlasGeneratedAssetCandidates(relativePath).find((candidate) => fs.existsSync(candidate));
  if (!assetPath) return null;
  const ext = path.extname(assetPath).toLowerCase();
  const contentType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".svg"
          ? "image/svg+xml"
          : "image/png";
  return {
    data: fs.readFileSync(assetPath),
    contentType,
  };
}

export function readAtlasArtifact(windowHours: number): AtlasArtifactPayload | null {
  const artifactPath = process.env.VIBEZ_ATLAS_ARTIFACT_PATH
    ? atlasArtifactPath(windowHours)
    : atlasArtifactCandidates(windowHours).find((candidate) => fs.existsSync(candidate));
  if (!artifactPath) return null;
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
