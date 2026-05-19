import type { Pool } from "pg";

import { attachGeneratedArticleImages, summarizeAtlasImageGeneration } from "./atlas-image-generation";
import { generateAtlasEditorialReport } from "./atlas-report";
import {
  editionTypeForWindow,
  startAtlasPublishJob,
  updateAtlasPublishStage,
  writeAtlasArtifact,
  type AtlasPublishJob,
} from "./atlas-artifact";
import { getAtlasSnapshot } from "./db";
import { embedTexts, generateJson } from "./model-router";
import {
  applyPgvectorPayload,
  ensurePostgresCoreSchema,
  getPgPool,
  type LinkEmbeddingPayload,
  type MessageEmbeddingPayload,
} from "./push-ingest";

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const EMBEDDING_BATCH_SIZE = 64;

interface MissingMessageRow {
  id: string;
  room_id: string;
  room_name: string;
  sender_id: string;
  sender_name: string;
  body: string;
  timestamp: number | string;
  relevance_score?: number | null;
  topics?: string | null;
  entities?: string | null;
  contribution_flag?: boolean | number | null;
  contribution_themes?: string | null;
  contribution_hint?: string | null;
  alert_level?: string | null;
}

interface MissingLinkRow {
  id: number | string;
  url: string;
  url_hash: string;
  title: string | null;
  category: string | null;
  relevance: string | null;
  shared_by: string | null;
  source_group: string | null;
  first_seen: string | null;
  last_seen: string | null;
  mention_count: number | string | null;
  value_score: number | string | null;
  report_date: string | null;
  authored_by: string | null;
  pinned: number | boolean | null;
}

interface ModelClassification {
  relevance_score?: unknown;
  topics?: unknown;
  entities?: unknown;
  contribution_flag?: unknown;
  contribution_themes?: unknown;
  contribution_hint?: unknown;
  alert_level?: unknown;
}

export interface RailwayEnrichmentOptions {
  classifyLimit?: number;
  messageEmbeddingLimit?: number;
  linkEmbeddingLimit?: number;
  rebuildAtlas?: boolean;
  atlasHours?: number;
  publishJobId?: string;
  prestartedPublishJob?: boolean;
}

export interface RailwayEnrichmentResult {
  ok: true;
  classifications_written: number;
  message_embeddings_written: number;
  link_embeddings_written: number;
  atlas: {
    rebuilt: boolean;
    artifact_path?: string;
    articles?: number;
    sections?: string[];
    publish_job_id?: string;
    edition_date?: string;
    edition_type?: string;
    window_hours?: number;
    published_at?: string;
    stage_summary?: Record<string, string>;
    skipped_reason?: string;
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function tableName(envName: string, fallback: string): string {
  const raw = (process.env[envName] || fallback).trim().toLowerCase();
  if (!IDENT_RE.test(raw)) {
    throw new Error(`Invalid ${envName} '${raw}'.`);
  }
  return raw;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value).toFixed(6)).join(",")}]`;
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

function normalizeAlertLevel(value: unknown): "hot" | "digest" | "none" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "hot" || normalized === "digest") return normalized;
  return "none";
}

function normalizeClassification(raw: ModelClassification): Required<ModelClassification> {
  return {
    relevance_score: clampInt(raw.relevance_score, 0, 0, 10),
    topics: normalizeTextList(raw.topics),
    entities: normalizeTextList(raw.entities),
    contribution_flag: Boolean(raw.contribution_flag),
    contribution_themes: normalizeTextList(raw.contribution_themes),
    contribution_hint: String(raw.contribution_hint || "").trim(),
    alert_level: normalizeAlertLevel(raw.alert_level),
  };
}

async function tableExists(pool: Pool, name: string): Promise<boolean> {
  const result = await pool.query("SELECT to_regclass($1) AS table_name", [name]);
  return Boolean(result.rows[0]?.table_name);
}

async function selectMissingClassifications(
  pool: Pool,
  limit: number,
): Promise<MissingMessageRow[]> {
  if (limit <= 0) return [];
  const result = await pool.query(
    `
      SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name, m.body, m.timestamp
      FROM messages m
      LEFT JOIN classifications c ON c.message_id = m.id
      WHERE c.message_id IS NULL
        AND length(trim(m.body)) > 0
      ORDER BY m.timestamp DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows as MissingMessageRow[];
}

async function selectMissingMessageEmbeddings(
  pool: Pool,
  limit: number,
): Promise<MissingMessageRow[]> {
  if (limit <= 0) return [];
  const embeddingTable = tableName("VIBEZ_PGVECTOR_TABLE", "vibez_message_embeddings");
  const hasEmbeddingTable = await tableExists(pool, embeddingTable);
  const join = hasEmbeddingTable
    ? `LEFT JOIN ${embeddingTable} e ON e.message_id = m.id`
    : "";
  const where = hasEmbeddingTable ? "AND e.message_id IS NULL" : "";
  const result = await pool.query(
    `
      SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name, m.body, m.timestamp,
             c.relevance_score, c.topics, c.entities, c.contribution_flag,
             c.contribution_themes, c.contribution_hint, c.alert_level
      FROM messages m
      LEFT JOIN classifications c ON c.message_id = m.id
      ${join}
      WHERE length(trim(m.body)) > 0
      ${where}
      ORDER BY m.timestamp DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows as MissingMessageRow[];
}

async function selectMissingLinkEmbeddings(
  pool: Pool,
  limit: number,
): Promise<MissingLinkRow[]> {
  if (limit <= 0) return [];
  const embeddingTable = tableName("VIBEZ_PGVECTOR_LINK_TABLE", "vibez_link_embeddings");
  const hasEmbeddingTable = await tableExists(pool, embeddingTable);
  const join = hasEmbeddingTable
    ? `LEFT JOIN ${embeddingTable} e ON e.link_id = l.id`
    : "";
  const where = hasEmbeddingTable ? "AND e.link_id IS NULL" : "";
  const result = await pool.query(
    `
      SELECT l.id, l.url, l.url_hash, l.title, l.category, l.relevance, l.shared_by,
             l.source_group, l.first_seen, l.last_seen, l.mention_count, l.value_score,
             l.report_date, l.authored_by, l.pinned
      FROM links l
      ${join}
      WHERE l.url IS NOT NULL
        AND l.url_hash IS NOT NULL
      ${where}
      ORDER BY coalesce(l.last_seen, l.first_seen, l.report_date, '') DESC, l.id DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows as MissingLinkRow[];
}

function classificationPrompt(message: MissingMessageRow): string {
  return [
    "Classify this message from a community of leading-edge AI practitioners.",
    "Return only JSON with these fields:",
    "relevance_score: integer 0-10 for how useful this message is to the community archive.",
    "topics: short topical labels.",
    "entities: people, products, projects, tools, companies, or named concepts mentioned.",
    "contribution_flag: true when the message contributes a reusable idea, useful evidence, decision, or action.",
    "contribution_themes: short labels for reusable contribution themes.",
    "contribution_hint: one compact sentence on what is worth preserving, or empty string.",
    "alert_level: one of hot, digest, none.",
    "",
    `Channel: ${message.room_name}`,
    `Member: ${message.sender_name}`,
    `Timestamp: ${message.timestamp}`,
    "Message:",
    message.body,
  ].join("\n");
}

async function classifyMissingMessages(
  pool: Pool,
  limit: number,
): Promise<number> {
  const messages = await selectMissingClassifications(pool, limit);
  let written = 0;
  for (const message of messages) {
    const result = await generateJson<ModelClassification>({
      taskId: "classification.inline",
      system: [
        "You classify community chat messages for an AI practitioner newspaper and archive.",
        "Make editorial judgments from the message itself. Do not invent facts.",
        "The people are community members, not users.",
        "Return valid JSON only.",
      ].join(" "),
      prompt: classificationPrompt(message),
    });
    const classification = normalizeClassification(result.parsed);
    await pool.query(
      `
        INSERT INTO classifications
          (message_id, relevance_score, topics, entities, contribution_flag,
           contribution_themes, contribution_hint, alert_level)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (message_id) DO UPDATE SET
          relevance_score = EXCLUDED.relevance_score,
          topics = EXCLUDED.topics,
          entities = EXCLUDED.entities,
          contribution_flag = EXCLUDED.contribution_flag,
          contribution_themes = EXCLUDED.contribution_themes,
          contribution_hint = EXCLUDED.contribution_hint,
          alert_level = EXCLUDED.alert_level
      `,
      [
        message.id,
        classification.relevance_score,
        JSON.stringify(classification.topics),
        JSON.stringify(classification.entities),
        classification.contribution_flag,
        JSON.stringify(classification.contribution_themes),
        classification.contribution_hint,
        classification.alert_level,
      ],
    );
    written += 1;
  }
  return written;
}

function messageEmbeddingText(message: MissingMessageRow): string {
  return [
    `Channel: ${message.room_name}`,
    `Member: ${message.sender_name}`,
    `Topics: ${message.topics || "[]"}`,
    `Entities: ${message.entities || "[]"}`,
    `Contribution themes: ${message.contribution_themes || "[]"}`,
    `Contribution hint: ${message.contribution_hint || ""}`,
    "",
    message.body,
  ].join("\n");
}

function linkEmbeddingText(link: MissingLinkRow): string {
  return [
    `Title: ${link.title || ""}`,
    `Category: ${link.category || ""}`,
    `Relevance: ${link.relevance || ""}`,
    `Shared by: ${link.shared_by || ""}`,
    `Channel: ${link.source_group || ""}`,
    `Author: ${link.authored_by || ""}`,
    `URL: ${link.url}`,
  ].join("\n");
}

function pgvectorDimensions(): number {
  return clampInt(process.env.VIBEZ_PGVECTOR_DIM, 256, 64, 3072);
}

async function embedMissingMessages(pool: Pool, limit: number): Promise<number> {
  const messages = await selectMissingMessageEmbeddings(pool, limit);
  let written = 0;
  for (let i = 0; i < messages.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = messages.slice(i, i + EMBEDDING_BATCH_SIZE);
    const embeddings = await embedTexts({
      taskId: "embedding.semantic",
      inputs: batch.map(messageEmbeddingText),
      dimensions: pgvectorDimensions(),
    });
    const rows: MessageEmbeddingPayload[] = batch.map((message, index) => ({
      message_id: message.id,
      room_id: message.room_id,
      room_name: message.room_name,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      body: message.body,
      timestamp: Number(message.timestamp),
      relevance_score: message.relevance_score ?? null,
      topics: message.topics ?? "[]",
      entities: message.entities ?? "[]",
      contribution_flag: message.contribution_flag ?? false,
      contribution_themes: message.contribution_themes ?? "[]",
      contribution_hint: message.contribution_hint ?? "",
      alert_level: message.alert_level ?? "none",
      embedding: vectorLiteral(embeddings.vectors[index] || []),
    }));
    const result = await applyPgvectorPayload({ message_embeddings: rows });
    written += result.message_embeddings_written;
  }
  return written;
}

async function embedMissingLinks(pool: Pool, limit: number): Promise<number> {
  const links = await selectMissingLinkEmbeddings(pool, limit);
  let written = 0;
  for (let i = 0; i < links.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = links.slice(i, i + EMBEDDING_BATCH_SIZE);
    const embeddings = await embedTexts({
      taskId: "embedding.semantic",
      inputs: batch.map(linkEmbeddingText),
      dimensions: pgvectorDimensions(),
    });
    const rows: LinkEmbeddingPayload[] = batch.map((link, index) => ({
      link_id: Number(link.id),
      url: link.url,
      url_hash: link.url_hash,
      title: link.title,
      category: link.category,
      relevance: link.relevance,
      shared_by: link.shared_by,
      source_group: link.source_group,
      first_seen: link.first_seen,
      last_seen: link.last_seen,
      mention_count: Number(link.mention_count ?? 1),
      value_score: Number(link.value_score ?? 0),
      report_date: link.report_date,
      authored_by: link.authored_by,
      pinned: link.pinned,
      embedding: vectorLiteral(embeddings.vectors[index] || []),
    }));
    const result = await applyPgvectorPayload({ link_embeddings: rows });
    written += result.link_embeddings_written;
  }
  return written;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

async function rebuildAtlas(
  hours: number,
  publishJob: AtlasPublishJob | null,
): Promise<RailwayEnrichmentResult["atlas"]> {
  if (process.env.VIBEZ_ATLAS_ARTIFACT_WRITE !== "1") {
    return { rebuilt: false, skipped_reason: "atlas artifact writing is disabled" };
  }
  const atlas = await getAtlasSnapshot({ windowHours: hours });
  let editorialReport: Awaited<ReturnType<typeof generateAtlasEditorialReport>>;
  try {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "write_articles",
      status: "running",
    });
    editorialReport = await generateAtlasEditorialReport(atlas);
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "write_articles",
      status: "succeeded",
    });
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "write_channel_reports",
      status: editorialReport.channel_reports?.length ? "succeeded" : "skipped",
    });
  } catch (error) {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "write_articles",
      status: "failed",
      error: errorMessage(error),
    });
    throw error;
  }
  let artifactPath = "";
  const stageSummary: Record<string, string> = {
    enrich: "succeeded",
    write_articles: "succeeded",
  };
  const channelReportStage = editorialReport.channel_reports?.length ? "succeeded" : "skipped";
  stageSummary.write_channel_reports = channelReportStage;
  try {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "generate_images",
      status: "running",
    });
    editorialReport = await attachGeneratedArticleImages({
      report: editorialReport,
      windowHours: hours,
      publishJobId: publishJob?.id,
    });
    const imageSummary = summarizeAtlasImageGeneration(editorialReport);
    const imageStage = imageSummary.ready > 0 ? "succeeded" : "skipped";
    stageSummary.generate_images = imageStage;
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "generate_images",
      status: imageStage,
    });
  } catch (error) {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "generate_images",
      status: "failed",
      error: errorMessage(error),
    });
    throw error;
  }
  try {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "publish",
      status: "running",
    });
    artifactPath = await writeAtlasArtifact({
      windowHours: hours,
      atlas,
      editorialReport,
    });
    stageSummary.publish = "succeeded";
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "publish",
      status: "succeeded",
    });
  } catch (error) {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "publish",
      status: "failed",
      error: errorMessage(error),
    });
    throw error;
  }
  return {
    rebuilt: true,
    artifact_path: artifactPath,
    publish_job_id: publishJob?.id,
    edition_date: editorialReport.issue.date,
    edition_type: editionTypeForWindow(hours),
    window_hours: hours,
    published_at: new Date().toISOString(),
    stage_summary: stageSummary,
    articles: editorialReport.articles.length,
    sections: editorialReport.articles.map((article) => article.section),
  };
}

export async function refreshRailwayEnrichment(
  options: RailwayEnrichmentOptions = {},
): Promise<RailwayEnrichmentResult> {
  const pool = getPgPool();
  if (!pool) {
    throw new Error("Postgres is not configured.");
  }
  await ensurePostgresCoreSchema(pool);
  const atlasHours = clampInt(options.atlasHours, 48, 6, 168);
  const shouldRebuildAtlas = options.rebuildAtlas !== false;
  const editionType = editionTypeForWindow(atlasHours);
  const editionDate = new Date().toISOString().slice(0, 10);
  const publishJob = shouldRebuildAtlas
    ? options.prestartedPublishJob && options.publishJobId
      ? {
        id: options.publishJobId,
        edition_date: editionDate,
        edition_type: editionType,
        window_hours: atlasHours,
        status: "running" as const,
      }
      : await startAtlasPublishJob({
        jobId: options.publishJobId,
        editionDate,
        editionType,
        windowHours: atlasHours,
      })
    : null;

  let classificationsWritten = 0;
  let messageEmbeddingsWritten = 0;
  let linkEmbeddingsWritten = 0;
  try {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "enrich",
      status: "running",
    });
    classificationsWritten = await classifyMissingMessages(
      pool,
      clampInt(options.classifyLimit, 80, 0, 500),
    );
    messageEmbeddingsWritten = await embedMissingMessages(
      pool,
      clampInt(options.messageEmbeddingLimit, 300, 0, 1000),
    );
    linkEmbeddingsWritten = await embedMissingLinks(
      pool,
      clampInt(options.linkEmbeddingLimit, 300, 0, 1000),
    );
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "enrich",
      status: "succeeded",
    });
  } catch (error) {
    await updateAtlasPublishStage({
      jobId: publishJob?.id,
      stage: "enrich",
      status: "failed",
      error: errorMessage(error),
    });
    throw error;
  }
  const atlas = shouldRebuildAtlas
    ? await rebuildAtlas(atlasHours, publishJob)
    : { rebuilt: false, skipped_reason: "not requested" };

  return {
    ok: true,
    classifications_written: classificationsWritten,
    message_embeddings_written: messageEmbeddingsWritten,
    link_embeddings_written: linkEmbeddingsWritten,
    atlas,
  };
}
