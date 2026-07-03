import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

import {
  editionTypeForWindow,
  upsertAtlasAsset,
  writeAtlasGeneratedAsset,
  type AtlasAssetStatus,
} from "./atlas-artifact";
import { generateImage } from "./model-router";
import type {
  AtlasEditorialArticle,
  AtlasEditorialReport,
} from "./atlas-report";

const execFileAsync = promisify(execFile);
const ARTICLE_IMAGE_WIDTH = 1440;
const ARTICLE_IMAGE_HEIGHT = 810;
const ARTICLE_IMAGE_WEBP_QUALITY = 80;

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

function clipText(value: unknown, maxChars: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeSceneBrief(value: string): string {
  return value
    .replace(/\bGitHub\b/gi, "an unlabeled code-hosting service")
    .replace(/\boctocat\b/gi, "a plain peeled patch")
    .replace(/\bstickers?\b/gi, "plain tape marks")
    .replace(/\bsticky notes?\b/gi, "unlabeled paper slips")
    .replace(/\bticker boards?\b/gi, "abstract market display panels")
    .replace(/\bcharts?\b/gi, "unlabeled visual indicators")
    .replace(/\bscreens?\b/gi, "dark glass panels")
    .replace(/\blogos?\b|\bbrand marks?\b/gi, "unlabeled marks")
    .replace(/\breadable text\b|\btypography\b|\bcaptions?\b|\blabels?\b|\bsigns?\b/gi, "unreadable detail");
}

function imagePromptFor(article: AtlasEditorialArticle, imagePrompt?: string): string {
  const channels = textList(article.channels);
  const evidenceRefs = textList(article.evidence_refs);
  const body = textList(article.body);
  const storyFacts = clipText(body.slice(0, 2).join(" "), 650);
  const sceneBrief = clipText(
    sanitizeSceneBrief(imagePrompt || `Documentary editorial photograph for ${article.title}`),
    420,
  );
  return [
    "Article-specific photo assignment:",
    "Use ONLY this article. Do not borrow context, characters, or metaphors from any other article.",
    `Title: ${clipText(article.title, 160)}`,
    `Section: ${clipText(article.section, 80)}`,
    `Dek: ${clipText(article.dek, 220)}`,
    "Hard bans: no readable text, logos, brand marks, stickers, mascots, icons, emoji, UI screenshots, or charts. If the scene brief mentions one, treat it as a concept and replace it with an unlabeled real-world equivalent.",
    `Scene brief: ${sceneBrief}`,
    `Story facts to depict: ${storyFacts}`,
    `Channels/citations: ${clipText(`${channels.join(", ")} ${evidenceRefs.join(", ")}`.trim(), 220)}`,
    "Meaning requirement: the scene must clearly relate to this article's concrete facts, tensions, and named concepts. Do not make a generic tech or business stock photo.",
    "Humor requirement: add snarky nerd humor only through plausible real-world object arrangement, scale, juxtaposition, or human body language. The joke should reward someone who read the article.",
    "Create a New York Times-style, single photorealistic documentary editorial photograph.",
    "Make it restrained, specific, observational, human, and plausible as a real newspaper photo.",
    "If the scene brief mentions a readable screen, book, sign, label, or chart, replace it with an unlabeled real-world equivalent.",
    "Avoid screenshots, typography, logos, charts, synthetic glow, glossy AI art, and product mockups. No readable text in the image.",
    "No stickers, icons, emoji, doodles, mascots, or symbols. Avoid books, sticky notes, labels, signs, screens, or packaging with legible writing.",
  ].join("\n").trim();
}

async function optimizeArticleImage(data: Buffer): Promise<{
  data: Buffer;
  contentType: string;
}> {
  const optimized = await sharp(data, { animated: false })
    .rotate()
    .resize({
      width: ARTICLE_IMAGE_WIDTH,
      height: ARTICLE_IMAGE_HEIGHT,
      fit: "cover",
      position: "center",
    })
    .webp({
      quality: ARTICLE_IMAGE_WEBP_QUALITY,
      effort: 5,
      smartSubsample: true,
    })
    .toBuffer();
  return {
    data: optimized,
    contentType: "image/webp",
  };
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

async function modelImageRunner(input: Parameters<AtlasImageRunner>[0]) {
  const generated = await generateImage({
    taskId: "image.article",
    prompt: input.prompt,
  });
  await fs.writeFile(input.outputPath, generated.data);
  return {
    data: generated.data,
    contentType: generated.contentType,
    provider: generated.provider,
    model: generated.model,
  };
}

async function defaultImageRunner(input: Parameters<AtlasImageRunner>[0]) {
  if ((process.env.VIBEZ_ATLAS_IMAGE_COMMAND || "").trim()) {
    return commandImageRunner(input);
  }
  return modelImageRunner(input);
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
  runner: AtlasImageRunner = defaultImageRunner,
): Promise<AtlasEditorialReport> {
  const editionType = editionTypeForWindow(windowHours);
  const editionDate = report.issue.date;
  const generationId = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
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
    const assetKey = `${editionDate}/${editionType}/${articleSlug}-${generationId}.webp`;
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
        const optimized = await optimizeArticleImage(generated.data);
        status = "ready";
        url = publicPath;
        writeAtlasGeneratedAsset(assetKey, optimized.data);
        await upsertAtlasAsset({
          ...baseAsset,
          status,
          assetBytes: optimized.data,
          contentType: optimized.contentType,
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
