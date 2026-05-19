import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  editionTypeForWindow,
  upsertAtlasAsset,
  writeAtlasGeneratedAsset,
  type AtlasAssetStatus,
} from "./atlas-artifact";
import type {
  AtlasEditorialArticle,
  AtlasEditorialReport,
} from "./atlas-report";

const execFileAsync = promisify(execFile);

export type AtlasImageRunner = (input: {
  prompt: string;
  outputPath: string;
  article: AtlasEditorialArticle;
  articleTitle: string;
  articleDek: string;
  articleSection: string;
  articleBody: string[];
  evidenceRefs: string[];
  linkRefs: string[];
  channels: string[];
}) => Promise<{
  data: Buffer;
  contentType: string;
  provider?: string | null;
  model?: string | null;
} | null>;

export interface AtlasImageGenerationResult {
  report: AtlasEditorialReport;
  attempted: number;
  ready: number;
  pending: number;
  failed: number;
}

function safePathSegment(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "article";
}

function contentTypeForPath(outputPath: string): string {
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function imagePromptFor(article: AtlasEditorialArticle, imagePrompt?: string): string {
  const channels = textList(article.channels);
  const evidenceRefs = textList(article.evidence_refs);
  const body = textList(article.body);
  return [
    imagePrompt || `NYTimes-style documentary editorial photograph for ${article.title}`,
    "",
    `Article: ${article.title}`,
    `Section: ${article.section}`,
    `Dek: ${article.dek}`,
    `Channels: ${channels.join(", ")}`,
    `Citations: ${evidenceRefs.join(", ")}`,
    "",
    "Article body:",
    body.join("\n\n"),
  ].join("\n").trim();
}

async function commandImageRunner(input: Parameters<AtlasImageRunner>[0]) {
  const command = (process.env.VIBEZ_ATLAS_IMAGE_COMMAND || "").trim();
  if (!command) return null;
  await execFileAsync("/bin/sh", ["-lc", command], {
    env: {
      ...process.env,
      ATLAS_IMAGE_PROMPT: input.prompt,
      ATLAS_IMAGE_OUTPUT: input.outputPath,
      ATLAS_IMAGE_ARTICLE_TITLE: input.articleTitle,
      ATLAS_IMAGE_ARTICLE_SECTION: input.articleSection,
      ATLAS_IMAGE_ARTICLE_DEK: input.articleDek,
    },
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    data: await fs.readFile(input.outputPath),
    contentType: contentTypeForPath(input.outputPath),
    provider: process.env.VIBEZ_ATLAS_IMAGE_PROVIDER || null,
    model: process.env.VIBEZ_ATLAS_IMAGE_MODEL || null,
  };
}

function assetStatusMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "image generation failed");
}

export async function attachGeneratedArticleImages(
  {
    report,
    windowHours,
    publishJobId,
  }: {
    report: AtlasEditorialReport;
    windowHours: number;
    publishJobId?: string | null;
  },
  runner: AtlasImageRunner = commandImageRunner,
): Promise<AtlasEditorialReport> {
  const editionType = editionTypeForWindow(windowHours);
  const editionDate = report.issue.date;
  const articles = [];

  for (const article of report.articles) {
    const currentImage = article.image || {
      kind: "generated" as const,
      prompt: `NYTimes-style documentary editorial photograph for ${article.title}`,
    };
    if (currentImage.kind !== "generated") {
      articles.push(article);
      continue;
    }

    const articleSlug = safePathSegment(article.slug || article.title);
    const assetKey = `${editionDate}/${editionType}/${articleSlug}.png`;
    const publicPath = `/api/atlas/image/${assetKey}`;
    const prompt = imagePromptFor(article, currentImage.prompt);
    const baseAsset = {
      assetKey,
      editionDate,
      editionType,
      windowHours,
      articleSlug,
      assetKind: "article_image" as const,
      prompt,
      publicPath,
      metadata: {
        publish_job_id: publishJobId || null,
        article_title: article.title,
      },
    };

    await upsertAtlasAsset({
      ...baseAsset,
      status: "pending",
      assetBytes: null,
    });

    let status: AtlasAssetStatus = "pending";
    let url: string | undefined;
    let error: string | undefined;
    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-image-"));
      const outputPath = path.join(tmpDir, `${articleSlug}.png`);
      const generated = await runner({
        prompt,
        outputPath,
        article,
        articleTitle: article.title,
        articleDek: article.dek,
        articleSection: article.section,
        articleBody: textList(article.body),
        evidenceRefs: textList(article.evidence_refs),
        linkRefs: textList(article.link_refs),
        channels: textList(article.channels),
      });
      if (generated?.data?.length) {
        status = "ready";
        url = publicPath;
        writeAtlasGeneratedAsset(assetKey, generated.data);
        await upsertAtlasAsset({
          ...baseAsset,
          status,
          assetBytes: generated.data,
          contentType: generated.contentType,
          provider: generated.provider || null,
          model: generated.model || null,
        });
      }
    } catch (generationError) {
      status = "failed";
      error = assetStatusMessage(generationError);
      await upsertAtlasAsset({
        ...baseAsset,
        status,
        assetBytes: null,
        error,
      });
    }

    articles.push({
      ...article,
      image: {
        ...currentImage,
        status,
        url,
        error,
        asset_key: assetKey,
      },
    });
  }

  return {
    ...report,
    articles,
  };
}

export function summarizeAtlasImageGeneration(report: AtlasEditorialReport): AtlasImageGenerationResult {
  const generatedImages = report.articles
    .map((article) => article.image)
    .filter((image) => image.kind === "generated");
  return {
    report,
    attempted: generatedImages.length,
    ready: generatedImages.filter((image) => image.status === "ready").length,
    pending: generatedImages.filter((image) => image.status === "pending").length,
    failed: generatedImages.filter((image) => image.status === "failed").length,
  };
}
