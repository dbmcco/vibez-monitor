import { generateJson } from "./model-router";

import type {
  AtlasCitation,
  AtlasConcern,
  AtlasSnapshot,
} from "./atlas";

export interface AtlasEditorialTheme {
  title: string;
  analysis: string;
  evidence_refs: string[];
}

export interface AtlasEditorialEvidence {
  ref: string;
  label: string;
  why_it_matters: string;
}

export interface AtlasEditorialMainTopic {
  title: string;
  paragraphs: string[];
  evidence_refs: string[];
}

export interface AtlasEditorialIssue {
  date: string;
  title: string;
  subtitle: string;
  edition_label: string;
}

export interface AtlasEditorialImage {
  kind: "generated" | "link" | "chat" | "none";
  prompt?: string;
  url?: string;
  alt?: string;
  status?: "pending" | "ready" | "failed" | "skipped";
  error?: string;
  asset_key?: string;
}

export interface AtlasEditorialArticle {
  role: "lead" | "secondary";
  section: string;
  title: string;
  slug: string;
  dek: string;
  summary: string;
  body: string[];
  paragraph_citations?: string[][];
  actions: string[];
  evidence_refs: string[];
  link_refs: string[];
  channels: string[];
  image: AtlasEditorialImage;
  related_article_slugs: string[];
}

export interface AtlasEditorialBrief {
  title: string;
  text: string;
  evidence_refs: string[];
}

export interface AtlasEditorialCrosscurrent {
  title: string;
  text: string;
  channels: string[];
  evidence_refs: string[];
}

export interface AtlasEditorialChannelReport {
  channel: string;
  headline: string;
  summary: string;
  why_it_matters: string;
  action: string;
  evidence_refs: string[];
}

export interface AtlasEditorialReport {
  issue: AtlasEditorialIssue;
  headline: string;
  dek: string;
  what_happened: string[];
  what_it_means: string[];
  why_care: string[];
  valuable: string[];
  actions: string[];
  main_topic: AtlasEditorialMainTopic;
  articles: AtlasEditorialArticle[];
  briefs: AtlasEditorialBrief[];
  crosscurrents: AtlasEditorialCrosscurrent[];
  channel_reports: AtlasEditorialChannelReport[];
  themes: AtlasEditorialTheme[];
  evidence: AtlasEditorialEvidence[];
  generated_at: string;
}

type AtlasEditorialShell = Omit<AtlasEditorialReport, "articles" | "generated_at"> & {
  article_seeds?: unknown[];
};

export interface AtlasReportEvidencePack {
  window: AtlasSnapshot["window"];
  overview: AtlasSnapshot["overview"];
  channels: AtlasSnapshot["channels"];
  topics: AtlasSnapshot["topics"];
  concerns: AtlasConcern[];
  links: AtlasSnapshot["links"];
  citations: Array<{
    ref: string;
    type: AtlasCitation["type"];
    label: string;
    channel?: string;
    sender?: string;
    timestamp?: number;
    topics?: string[];
    text?: string;
    url?: string;
    title?: string;
  }>;
}

interface AtlasReportMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type AtlasReportGenerator = (args: {
  taskId: string;
  prompt?: string;
  system?: string;
  messages?: AtlasReportMessage[];
  manifestPath?: string;
}) => Promise<{ parsed: unknown }>;

const REQUIRED_LIST_FIELDS = [
  "what_happened",
  "what_it_means",
  "why_care",
  "valuable",
  "actions",
] as const;

export function buildAtlasReportEvidence(atlas: AtlasSnapshot): AtlasReportEvidencePack {
  const refs = new Set<string>();

  for (const ref of atlas.narrative.report.evidence_refs) refs.add(ref);
  for (const channel of atlas.channels.slice(0, 8)) {
    for (const ref of channel.citation_refs.slice(0, 3)) refs.add(ref);
  }
  for (const topic of atlas.topics.slice(0, 6)) {
    for (const ref of topic.citation_refs) refs.add(ref);
  }
  for (const concern of atlas.concerns.slice(0, 8)) {
    for (const ref of concern.citation_refs) refs.add(ref);
  }
  for (const link of atlas.links.slice(0, 8)) refs.add(link.ref);

  const citations = Array.from(refs)
    .map((ref) => atlas.citations[ref])
    .filter((citation): citation is AtlasCitation => Boolean(citation))
    .slice(0, 24)
    .map((citation) => ({
      ref: citation.ref,
      type: citation.type,
      label: citation.label,
      channel: citation.channel,
      sender: citation.sender,
      timestamp: citation.timestamp,
      topics: citation.topics,
      text: citation.body,
      url: citation.url,
      title: citation.title,
    }));

  return {
    window: atlas.window,
    overview: atlas.overview,
    channels: atlas.channels.slice(0, 10),
    topics: atlas.topics.slice(0, 10),
    concerns: atlas.concerns.slice(0, 10),
    links: atlas.links.slice(0, 10),
    citations,
  };
}

export function buildAtlasReportMessages(atlas: AtlasSnapshot): AtlasReportMessage[] {
  const evidence = buildAtlasReportEvidence(atlas);
  return [
    {
      role: "system",
      content: [
        "You are Edward R. Murrow serving as editor and analyst for Vibez Atlas.",
        "Write with Murrow's public-service gravity: precise observation, plain moral stakes, disciplined skepticism, and sentences that move cleanly from fact to consequence.",
        "Honor Strunk and White: prefer concrete nouns, active verbs, and clean structure.",
        "Keep the voice humane, literate, and calm under pressure. Prefer concrete nouns, active verbs, short sentences, and earned judgment. Omit needless words.",
        "Let wit appear only as dry clarity. Never chase a joke, never pad the copy, and never mistake atmosphere for reporting.",
        "Do not use emoji, decorative symbols, or meme punctuation.",
        "Do not invent facts. Tie every major claim to the supplied citation refs.",
        "The community members reading this are leading-edge AI practitioners. They want analysis, not a pile of links.",
        "You are creating a daily newspaper issue, not a single-theme dashboard summary.",
        `The evidence window is ${atlas.window.hours} hours, from ${atlas.window.start} to ${atlas.window.end}. Use that window accurately; do not call it a week unless the evidence window is at least 120 hours.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write the latest Atlas report from this evidence pack as a daily newspaper issue.",
        `This issue covers ${atlas.window.hours} hours. For this issue, do not write "this week", "weekly", or "week in review"; write "in this ${atlas.window.hours}-hour window", "over the latest window", or another accurate phrase.`,
        "Do not reduce the day to one theme unless the evidence truly supports that. Prefer one lead story plus several first-class side stories.",
        "You MUST include exactly 5 articles: exactly one lead article plus four secondary articles, so the front page has two left-lane stories, one center lead, and two right-lane stories.",
        "Each article MUST include a short plain-text section label that names its theme, like Personal Workflows, Agent Harnesses, Evidence Systems, or Durable Records.",
        "Section labels MUST NOT contain emoji, decorative symbols, punctuation runs, or jokes.",
        "Each article body is the full read-more page and MUST contain at least five paragraphs, kept compact.",
        "Write article bodies as paragraph objects: {\"text\":\"finished prose paragraph\",\"citation_refs\":[\"vibez:message:...\"]}.",
        "Do not label the paragraphs; use the five-paragraph arc as structure beneath the prose.",
        "At least the first four article paragraphs should carry citation_refs. The fifth should carry citations when the action depends on a source.",
        "Every article must carry citations: include at least one valid evidence_refs entry, and use citation refs to support every major claim.",
        "Every article image must include a generated image brief: image.kind must be generated unless a real source image URL exists, image.prompt must describe a NYTimes-style documentary editorial photograph grounded in the article context, with dry clever nerd humor or nerd-meme references only when they serve the story. Avoid visible text, logos, cartoons, and glossy AI aesthetics. image.alt must describe the image for the page.",
        "Write channel_reports for rooms where the evidence supports a useful room-level report. Each must answer what happened there, why it matters, what to watch or action, and cite evidence refs.",
        "Answer these questions plainly:",
        "1. What happened?",
        "2. What does this mean?",
        "3. Why should I care?",
        "4. What is valuable here?",
        "5. What do I need to action here?",
        "",
        "Return strict JSON with this shape:",
        JSON.stringify(
          {
            issue: {
              date: "YYYY-MM-DD",
              title: "The Vibez Atlas",
              subtitle: "one sentence issue summary",
              edition_label: "Daily Edition",
            },
            headline: "short human headline",
            dek: "one sentence that says what matters",
            what_happened: ["2-4 concise paragraphs or bullets"],
            what_it_means: ["2-4 concise paragraphs or bullets"],
            why_care: ["2-4 concise paragraphs or bullets"],
            valuable: ["2-4 concise paragraphs or bullets"],
            actions: ["2-5 concrete next actions"],
            main_topic: {
              title: "main topic",
              paragraphs: [
                "Setup: name the central theme and the tension behind it.",
                "What happened: report the concrete activity from the evidence.",
                "What it means: explain the implication without hype.",
                "Why it matters: say why a reader should care.",
                "Next move: state the useful action or watch point.",
              ],
              evidence_refs: ["vibez:message:..."],
            },
            articles: [
              {
                role: "lead",
                section: "Agent Harnesses",
                title: "front-page article title",
                dek: "one sentence article deck",
                summary: "two sentence article card summary",
                body: [
                  { text: "Concrete reported opening paragraph.", citation_refs: ["vibez:message:..."] },
                  { text: "Evidence paragraph with source details.", citation_refs: ["vibez:message:..."] },
                  { text: "Analysis paragraph explaining consequence.", citation_refs: ["vibez:message:..."] },
                  { text: "Value paragraph about why it matters.", citation_refs: ["vibez:message:..."] },
                  { text: "Action paragraph naming the next useful move.", citation_refs: ["vibez:message:..."] },
                ],
                actions: ["concrete next action"],
                evidence_refs: ["vibez:message:..."],
                link_refs: ["vibez:link:..."],
                channels: ["channel name"],
                image: {
                  kind: "generated",
                  prompt: "NYTimes-style documentary editorial photograph grounded in the article, with dry clever nerd humor when useful",
                  alt: "short accessible image description",
                },
                related_article_slugs: ["related article title or slug"],
              },
              {
                role: "secondary",
                section: "Personal Workflows",
                title: "left-side article title",
                dek: "one sentence article deck",
                summary: "two sentence article card summary",
                body: [
                  { text: "Concrete reported opening paragraph.", citation_refs: ["vibez:message:..."] },
                  { text: "Evidence paragraph with source details.", citation_refs: ["vibez:message:..."] },
                  { text: "Analysis paragraph explaining consequence.", citation_refs: ["vibez:message:..."] },
                  { text: "Value paragraph about why it matters.", citation_refs: ["vibez:message:..."] },
                  { text: "Action paragraph naming the next useful move.", citation_refs: ["vibez:message:..."] },
                ],
                actions: ["concrete next action"],
                evidence_refs: ["vibez:message:..."],
                link_refs: ["vibez:link:..."],
                channels: ["channel name"],
                image: {
                  kind: "generated",
                  prompt: "NYTimes-style documentary editorial photograph grounded in the article, with dry clever nerd humor when useful",
                  alt: "short accessible image description",
                },
                related_article_slugs: [],
              },
              {
                role: "secondary",
                section: "Durable Records",
                title: "right-side article title",
                dek: "one sentence article deck",
                summary: "two sentence article card summary",
                body: [
                  { text: "Concrete reported opening paragraph.", citation_refs: ["vibez:message:..."] },
                  { text: "Evidence paragraph with source details.", citation_refs: ["vibez:message:..."] },
                  { text: "Analysis paragraph explaining consequence.", citation_refs: ["vibez:message:..."] },
                  { text: "Value paragraph about why it matters.", citation_refs: ["vibez:message:..."] },
                  { text: "Action paragraph naming the next useful move.", citation_refs: ["vibez:message:..."] },
                ],
                actions: ["concrete next action"],
                evidence_refs: ["vibez:message:..."],
                link_refs: ["vibez:link:..."],
                channels: ["channel name"],
                image: {
                  kind: "generated",
                  prompt: "NYTimes-style documentary editorial photograph grounded in the article, with dry clever nerd humor when useful",
                  alt: "short accessible image description",
                },
                related_article_slugs: [],
              },
            ],
            briefs: [
              {
                title: "minor but interesting item",
                text: "short human note",
                evidence_refs: ["vibez:message:..."],
              },
            ],
            crosscurrents: [
              {
                title: "how rooms relate",
                text: "where channels converge, diverge, or talk past each other",
                channels: ["channel name"],
                evidence_refs: ["vibez:message:..."],
              },
            ],
            channel_reports: [
              {
                channel: "channel name",
                headline: "what happened in this room",
                summary: "short reported summary of the room-level signal",
                why_it_matters: "why this room signal matters to a reader",
                action: "what to watch or do next",
                evidence_refs: ["vibez:message:..."],
              },
            ],
            themes: [
              {
                title: "theme name",
                analysis: "what this theme is really about",
                evidence_refs: ["vibez:message:..."],
              },
            ],
            evidence: [
              {
                ref: "vibez:message:...",
                label: "short label",
                why_it_matters: "why this evidence earns its place",
              },
            ],
          },
          null,
          2,
        ),
        "",
        "Evidence pack:",
        JSON.stringify(evidence, null, 2),
      ].join("\n"),
    },
  ];
}

export async function generateAtlasEditorialReport(
  atlas: AtlasSnapshot,
  generator: AtlasReportGenerator = generateJson<unknown>,
): Promise<AtlasEditorialReport> {
  const messages = buildAtlasIssueShellMessages(atlas);
  const result = await generateAtlasReportJson(generator, {
    taskId: "dashboard.atlas_report",
    messages,
  });
  let parsed = result.parsed;
  let shell: AtlasEditorialShell | null = null;
  let validationError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      shell = normalizeAtlasEditorialShell(parsed, atlas);
      break;
    } catch (error) {
      validationError = error instanceof Error ? error.message : "schema validation failed";
      const repaired = await generateAtlasReportJson(generator, {
        taskId: "dashboard.atlas_report",
        messages: buildAtlasIssueShellRepairMessages({
          atlas,
          invalidReport: parsed,
          validationError,
        }),
      });
      parsed = repaired.parsed;
    }
  }
  if (!shell) {
    shell = normalizeAtlasEditorialShell(parsed, atlas);
  }

  const articleSeeds = shell.article_seeds || [];
  const articles = await repairArticlesIndividually({
    atlas,
    invalidReport: { ...shell, articles: articleSeeds },
    validationError: "Atlas newspaper articles must be complete, cited, five-paragraph story pages.",
    generator,
  });
  parsed = { ...shell, articles };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return normalizeAtlasEditorialReport(parsed, atlas);
    } catch (error) {
      validationError = error instanceof Error ? error.message : "schema validation failed";
      if (isArticleValidationError(validationError)) {
        const repaired = await generateAtlasReportJson(generator, {
          taskId: "dashboard.atlas_report",
          messages: buildAtlasArticleRepairMessages({
            atlas,
            invalidReport: parsed,
            validationError,
          }),
        });
        parsed = mergeArticleRepair(parsed, repaired.parsed);
        try {
          return normalizeAtlasEditorialReport(parsed, atlas);
        } catch (repairError) {
          const repairMessage = repairError instanceof Error ? repairError.message : "";
          if (!isArticleValidationError(repairMessage)) continue;
          const articles = await repairArticlesIndividually({
            atlas,
            invalidReport: parsed,
            validationError: repairMessage || validationError,
            generator,
          });
          parsed = mergeArticleRepair(parsed, { articles });
        }
        continue;
      }
      const repaired = await generateAtlasReportJson(generator, {
        taskId: "dashboard.atlas_report",
        messages: buildAtlasReportRepairMessages({
          atlas,
          invalidReport: parsed,
          validationError,
        }),
      });
      parsed = repaired.parsed;
    }
  }

  try {
    return normalizeAtlasEditorialReport(parsed, atlas);
  } catch (error) {
    throw new Error(
      `atlas editorial report repair failed: ${
        error instanceof Error ? error.message : validationError || "schema validation failed"
      }`,
    );
  }
}

async function generateAtlasReportJson(
  generator: AtlasReportGenerator,
  args: Parameters<AtlasReportGenerator>[0],
): Promise<{ parsed: unknown }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await generator(args);
    } catch (error) {
      lastError = error;
      if (!isJsonParseFailure(error)) throw error;
    }
  }
  throw lastError;
}

function isJsonParseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error instanceof SyntaxError ||
    /JSON|Unexpected end/i.test(error.message || "");
}

export function buildAtlasIssueShellMessages(atlas: AtlasSnapshot): AtlasReportMessage[] {
  const evidence = buildAtlasReportEvidence(atlas);
  return [
    {
      role: "system",
      content: [
        "You are Edward R. Murrow serving as editor and analyst for Vibez Atlas.",
        "Write with public-service gravity: precise observation, plain stakes, disciplined skepticism, and clean sentences.",
        "Honor Strunk and White: concrete nouns, active verbs, and no needless words.",
        "The community members reading this are leading-edge AI practitioners. They want analysis, not link snippets.",
        "Do not invent facts. Use only supplied citation refs.",
        `The evidence window is ${atlas.window.hours} hours, from ${atlas.window.start} to ${atlas.window.end}. Use that window accurately; do not call it a week unless the evidence window is at least 120 hours.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write only the compact editorial shell for the latest Atlas newspaper issue.",
        `This issue covers ${atlas.window.hours} hours. For this issue, do not write "this week", "weekly", or "week in review"; write "in this ${atlas.window.hours}-hour window", "over the latest window", or another accurate phrase.`,
        "Do not write full article bodies in this pass.",
        "You own story selection. Do not simply choose the busiest channels or force one grand theme across unrelated evidence.",
        "Name exactly five themes that deserve separate articles because they help a reader understand what happened, what changed, what matters, and what needs action.",
        "Prefer useful, surprising, human, decision-relevant story angles over generic channel summaries.",
        "Keep article seeds grounded in citations across different active channels where the evidence supports it.",
        "You MUST include exactly 5 article_seeds: one lead and four secondary stories.",
        "Do not merge unrelated citations into one story just to make the page look tidy.",
        "Also write channel_reports for the rooms where the evidence supports a useful room-level read.",
        "Each channel report must be model-written from channel evidence and answer what happened there, why it matters, what to watch or action, and which citation refs support it.",
        "Do not output a channel report for a room if the evidence pack does not support a useful report.",
        "If evidence is thin or odd, say so plainly.",
        "Never refer to people as users. Say community members, practitioners, contributors, or people.",
        "Return strict JSON with this shape:",
        JSON.stringify(
          {
            issue: {
              date: "YYYY-MM-DD",
              title: "The Vibez Atlas",
              subtitle: "one sentence issue summary",
              edition_label: "Daily Edition",
            },
            headline: "short human headline",
            dek: "one sentence that says what matters",
            what_happened: ["2-4 concise bullets"],
            what_it_means: ["2-4 concise bullets"],
            why_care: ["2-4 concise bullets"],
            valuable: ["2-4 concise bullets"],
            actions: ["2-5 concrete next actions"],
            main_topic: {
              title: "main topic",
              paragraphs: [
                "Setup paragraph.",
                "What happened paragraph.",
                "What it means paragraph.",
                "Why it matters paragraph.",
                "Next move paragraph.",
              ],
              evidence_refs: ["vibez:message:..."],
            },
            article_seeds: [
              {
                role: "lead",
                section: "Plain Theme Label",
                title: "sober article title",
                dek: "article angle",
                why_this_story: "why this deserves a front-page article",
                evidence_refs: ["vibez:message:..."],
                channels: ["channel name"],
              },
              {
                role: "secondary",
                section: "Plain Theme Label",
                title: "sober article title",
                dek: "article angle",
                why_this_story: "why this deserves a separate article",
                evidence_refs: ["vibez:message:..."],
                channels: ["channel name"],
              },
              {
                role: "secondary",
                section: "Plain Theme Label",
                title: "sober article title",
                dek: "article angle",
                why_this_story: "why this deserves a separate article",
                evidence_refs: ["vibez:message:..."],
                channels: ["channel name"],
              },
              {
                role: "secondary",
                section: "Plain Theme Label",
                title: "third side article title",
                dek: "article angle",
                why_this_story: "why this deserves a separate article",
                evidence_refs: ["vibez:message:..."],
                channels: ["channel name"],
              },
              {
                role: "secondary",
                section: "Plain Theme Label",
                title: "fourth side article title",
                dek: "article angle",
                why_this_story: "why this deserves a separate article",
                evidence_refs: ["vibez:message:..."],
                channels: ["channel name"],
              },
            ],
            briefs: [
              {
                title: "minor but interesting item",
                text: "short human note",
                evidence_refs: ["vibez:message:..."],
              },
            ],
            crosscurrents: [
              {
                title: "how rooms relate",
                text: "where channels converge, diverge, or talk past each other",
                channels: ["channel name"],
                evidence_refs: ["vibez:message:..."],
              },
            ],
            channel_reports: [
              {
                channel: "channel name",
                headline: "what happened in this room",
                summary: "short reported summary of the room-level signal",
                why_it_matters: "why this room signal matters to a reader",
                action: "what to watch or do next",
                evidence_refs: ["vibez:message:..."],
              },
            ],
            themes: [
              {
                title: "theme name",
                analysis: "what this theme is really about",
                evidence_refs: ["vibez:message:..."],
              },
            ],
            evidence: [
              {
                ref: "vibez:message:...",
                label: "short label",
                why_it_matters: "why this evidence earns its place",
              },
            ],
          },
          null,
          2,
        ),
        "",
        "Evidence pack:",
        JSON.stringify(evidence, null, 2),
      ].join("\n"),
    },
  ];
}

function buildAtlasIssueShellRepairMessages({
  atlas,
  invalidReport,
  validationError,
}: {
  atlas: AtlasSnapshot;
  invalidReport: unknown;
  validationError: string;
}): AtlasReportMessage[] {
  return [
    {
      role: "system",
      content: [
        "You repair only the compact Vibez Atlas issue shell.",
        "Return strict JSON only. Do not write full article bodies.",
        "Do not invent facts. Use only supplied evidence refs.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Repair this issue shell so the required fields are present.",
        `Validation error: ${validationError}`,
        "main_topic must have a title, exactly five paragraphs, and valid evidence_refs.",
        "article_seeds must contain exactly one lead and four secondary article angles.",
        "Each article_seed must be an editorial choice, not a mechanical channel summary.",
        "Each article_seed must include role, section, title, dek, why_this_story, evidence_refs, and channels.",
        "Do not choose story angles by busiest channel alone. Choose what best explains what happened, why it matters, and what needs action.",
        "",
        "Invalid shell:",
        JSON.stringify(invalidReport, null, 2),
        "",
        "Evidence pack:",
        JSON.stringify(buildAtlasReportEvidence(atlas), null, 2),
      ].join("\n"),
    },
  ];
}

function isArticleValidationError(message: string): boolean {
  return /newspaper articles|five cited paragraphs|article body/i.test(message);
}

function mergeArticleRepair(base: unknown, repaired: unknown): unknown {
  if (!base || typeof base !== "object") return base;
  const basePayload = base as Record<string, unknown>;
  const repairedPayload = repaired && typeof repaired === "object"
    ? repaired as Record<string, unknown>
    : {};
  const articles = Array.isArray(repaired)
    ? repaired
    : Array.isArray(repairedPayload.articles)
      ? repairedPayload.articles
      : [];
  return {
    ...basePayload,
    articles,
  };
}

export function buildAtlasArticleRepairMessages({
  atlas,
  invalidReport,
  validationError,
}: {
  atlas: AtlasSnapshot;
  invalidReport: unknown;
  validationError: string;
}): AtlasReportMessage[] {
  const evidence = buildAtlasReportEvidence(atlas);
  return [
    {
      role: "system",
      content: [
        "You repair only the newspaper articles for Vibez Atlas.",
        "Return strict JSON only in the form {\"articles\":[...]}",
        "Do not invent facts. Use only supplied evidence refs.",
        "Do not use emoji, decorative symbols, or meme punctuation.",
        `The evidence window is ${atlas.window.hours} hours, from ${atlas.window.start} to ${atlas.window.end}. Use that window accurately; do not call it a week unless the evidence window is at least 120 hours.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Repair only the newspaper articles for this Atlas issue.",
        `This issue covers ${atlas.window.hours} hours. For this issue, do not write "this week", "weekly", or "week in review"; write "in this ${atlas.window.hours}-hour window", "over the latest window", or another accurate phrase.`,
        `Validation error: ${validationError}`,
        "Keep the existing issue/headline/dek/main_topic implied by the invalid report.",
        "Return exactly one lead article plus four secondary articles.",
        "Each article must have role, section, title, dek, summary, body, actions, evidence_refs, link_refs, channels, image, and related_article_slugs.",
        "Each article body must contain at least five compact natural paragraph objects with text and citation_refs.",
        "At least the first four paragraphs should include citation_refs from that article's evidence pack.",
        "Do not return placeholders like Lead paragraph, Evidence paragraph, or Paragraph 1.",
        "Do not prefix paragraphs with labels. Write the actual prose.",
        "Each article must include at least one valid evidence_refs citation from the evidence pack.",
        "Each article image must include kind, prompt, and alt; kind should be generated unless a real source image URL exists.",
        "Image prompts must describe a NYTimes-style documentary editorial photograph grounded in the article context, with dry clever nerd humor or nerd-meme references only when they serve the story. Avoid visible text, logos, cartoons, and glossy AI aesthetics.",
        "Section labels must be plain theme labels, not jokes or decorative text.",
        "",
        "Return shape:",
        JSON.stringify(
          {
            articles: [
              {
                role: "lead",
                section: "Plain Theme Label",
                title: "non-empty title",
                dek: "non-empty deck",
                summary: "non-empty summary",
                body: [
                  { text: "A natural reporting paragraph about what happened.", citation_refs: ["vibez:message:..."] },
                  { text: "A natural evidence paragraph with concrete citation details.", citation_refs: ["vibez:message:..."] },
                  { text: "A natural analysis paragraph about what those details mean.", citation_refs: ["vibez:message:..."] },
                  { text: "A natural value paragraph about why this matters.", citation_refs: ["vibez:message:..."] },
                  { text: "A natural action paragraph about what to do next.", citation_refs: ["vibez:message:..."] },
                ],
                actions: ["concrete action"],
                evidence_refs: ["vibez:message:..."],
                link_refs: [],
                channels: ["channel name"],
                image: {
                  kind: "generated",
                  prompt: "NYTimes-style documentary editorial photograph with dry clever nerd humor when useful",
                  alt: "short accessible image description",
                },
                related_article_slugs: [],
              },
            ],
          },
          null,
          2,
        ),
        "",
        "Invalid report summary:",
        JSON.stringify(compactReportForArticleRepair(invalidReport), null, 2),
        "",
        "Evidence pack:",
        JSON.stringify(evidence, null, 2),
      ].join("\n"),
    },
  ];
}

async function repairArticlesIndividually({
  atlas,
  invalidReport,
  validationError,
  generator,
}: {
  atlas: AtlasSnapshot;
  invalidReport: unknown;
  validationError: string;
  generator: AtlasReportGenerator;
}): Promise<unknown[]> {
  const articleSeeds = buildArticleRepairSeeds(invalidReport, atlas);
  if (articleSeeds.length !== 5) {
    throw new Error("atlas editorial shell must provide exactly one lead and four cited secondary article seeds");
  }
  const articles: unknown[] = [];
  for (let index = 0; index < articleSeeds.length; index += 1) {
    const repaired = await generateAtlasReportJson(generator, {
      taskId: "dashboard.atlas_report",
      messages: buildAtlasSingleArticleRepairMessages({
        atlas,
        invalidReport,
        articleSeed: articleSeeds[index],
        articleIndex: index,
        validationError,
      }),
    });
    articles.push(readRepairedArticle(repaired.parsed));
  }
  return articles;
}

function readRepairedArticle(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const payload = value as Record<string, unknown>;
  return payload.article || value;
}

function buildArticleRepairSeeds(invalidReport: unknown, atlas: AtlasSnapshot): unknown[] {
  const allowedRefs = new Set(Object.keys(atlas.citations));
  const payload = invalidReport && typeof invalidReport === "object"
    ? invalidReport as Record<string, unknown>
    : {};
  return readArticleSeeds(payload.articles, allowedRefs).slice(0, 6);
}

function compactReportForArticleRepair(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const payload = value as Record<string, unknown>;
  const articles = Array.isArray(payload.articles)
    ? payload.articles.slice(0, 6).map((item) => {
      if (!item || typeof item !== "object") return item;
      const article = item as Record<string, unknown>;
      const body = readArticleBody(article.body, new Set());
      return {
        role: article.role,
        section: article.section,
        title: article.title,
        dek: article.dek,
        summary: article.summary,
        body: body.body,
        paragraph_citations: body.paragraphCitations,
        evidence_refs: readTextList(article.evidence_refs),
        link_refs: readTextList(article.link_refs),
        channels: readTextList(article.channels),
        image: article.image,
      };
    })
    : [];
  return {
    headline: payload.headline,
    dek: payload.dek,
    main_topic: payload.main_topic,
    actions: readTextList(payload.actions),
    articles,
  };
}

export function buildAtlasSingleArticleRepairMessages({
  atlas,
  invalidReport,
  articleSeed,
  articleIndex,
  validationError,
}: {
  atlas: AtlasSnapshot;
  invalidReport: unknown;
  articleSeed: unknown;
  articleIndex: number;
  validationError: string;
}): AtlasReportMessage[] {
  const evidence = buildArticleEvidence(atlas, articleSeed);
  const role = articleIndex === 0 ? "lead" : "secondary";
  return [
    {
      role: "system",
      content: [
        "You repair one Vibez Atlas newspaper article.",
        "Return strict JSON only in the form {\"article\":{...}}",
        "Do not invent facts. Use only supplied evidence refs.",
        "Write for community members who are leading-edge AI practitioners, never for generic users.",
        "Use Edward R. Murrow's plain public-service style and Strunk and White discipline.",
        `The evidence window is ${atlas.window.hours} hours, from ${atlas.window.start} to ${atlas.window.end}. Use that window accurately; do not call it a week unless the evidence window is at least 120 hours.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write one complete article for this Atlas newspaper issue.",
        `This issue covers ${atlas.window.hours} hours. For this issue, do not write "this week", "weekly", or "week in review"; write "in this ${atlas.window.hours}-hour window", "over the latest window", or another accurate phrase.`,
        `Validation error: ${validationError}`,
        `Required role: ${role}`,
        "The title must be sober and specific. No puns, hype, cutesy metaphors, or mock newspaper voice.",
        "The section must be a plain theme label, not a chat room name with emoji or punctuation.",
        "The body must contain at least five compact natural paragraph objects with text and citation_refs.",
        "Do not prefix paragraphs with Lead, Evidence, Analysis, Value, Action, or similar labels.",
        "Use this five-paragraph arc without labeling it: report what happened; show what the citations say; explain what it means; explain why the reader should care; name the action or watch point.",
        "At least paragraphs 1 through 4 should include citation_refs from this article's evidence pack. Paragraph 5 should cite when the action depends on a source.",
        "If the evidence is odd, thin, or inconclusive, say that plainly instead of manufacturing certainty.",
        "Never refer to people as users. Say community members, practitioners, contributors, or people.",
        "Use at least one valid evidence_refs entry from the evidence pack.",
        "Do not make generic claims about AI agents, privacy, security, or project quality unless a citation directly supports them.",
        "Weak: \"AI agents are becoming more important, and the community should pay attention.\"",
        "Better: \"Dana named the evaluation loop as the blocker, and Lee tied the same problem to durable records before the weekly readout.\"",
        "Set image.kind to generated and include image.prompt and image.alt.",
        "The image.prompt must describe a NYTimes-style documentary editorial photograph grounded in the article context, with dry clever nerd humor or nerd-meme references only when they serve the story. Avoid visible text, logos, cartoons, and glossy AI aesthetics.",
        "Return shape:",
        JSON.stringify(
          {
            article: {
              role,
              section: "Plain Theme Label",
              title: "non-empty title",
              dek: "non-empty deck",
              summary: "two sentence card summary",
              body: [
                { text: "A natural reporting paragraph about what happened.", citation_refs: ["vibez:message:..."] },
                { text: "A natural evidence paragraph with concrete details from the citations.", citation_refs: ["vibez:message:..."] },
                { text: "A natural analysis paragraph about what those details mean.", citation_refs: ["vibez:message:..."] },
                { text: "A natural value paragraph about why this matters to the reader.", citation_refs: ["vibez:message:..."] },
                { text: "A natural action paragraph about what to do or watch next.", citation_refs: ["vibez:message:..."] },
              ],
              actions: ["concrete action"],
              evidence_refs: ["vibez:message:..."],
              link_refs: [],
              channels: ["channel name"],
              image: {
                kind: "generated",
                prompt: "NYTimes-style documentary editorial photograph with dry clever nerd humor when useful",
                alt: "short accessible image description",
              },
              related_article_slugs: [],
            },
          },
          null,
          2,
        ),
        "",
        "Issue summary:",
        JSON.stringify(compactReportForArticleRepair(invalidReport), null, 2),
        "",
        "Article seed to repair:",
        JSON.stringify(articleSeed, null, 2),
        "",
        "Evidence pack:",
        JSON.stringify(evidence, null, 2),
      ].join("\n"),
    },
  ];
}

function buildArticleEvidence(atlas: AtlasSnapshot, articleSeed: unknown): AtlasReportEvidencePack {
  const fullEvidence = buildAtlasReportEvidence(atlas);
  if (!articleSeed || typeof articleSeed !== "object") return fullEvidence;
  const seed = articleSeed as Record<string, unknown>;
  const seedRefs = new Set(readTextList(seed.evidence_refs));
  if (seedRefs.size === 0) return fullEvidence;
  const citations = Array.from(seedRefs)
    .map((ref) => atlas.citations[ref])
    .filter((citation): citation is AtlasCitation => Boolean(citation))
    .map((citation) => ({
      ref: citation.ref,
      type: citation.type,
      label: citation.label,
      channel: citation.channel,
      sender: citation.sender,
      timestamp: citation.timestamp,
      topics: citation.topics,
      text: citation.body,
      url: citation.url,
      title: citation.title,
    }));
  return {
    ...fullEvidence,
    channels: fullEvidence.channels.filter((channel) =>
      channel.citation_refs.some((ref) => seedRefs.has(ref)),
    ),
    topics: fullEvidence.topics.filter((topic) =>
      topic.citation_refs.some((ref) => seedRefs.has(ref)),
    ),
    concerns: fullEvidence.concerns.filter((concern) =>
      concern.citation_refs.some((ref) => seedRefs.has(ref)),
    ),
    links: fullEvidence.links.filter((link) => seedRefs.has(link.ref)),
    citations,
  };
}

export function buildAtlasReportRepairMessages({
  atlas,
  invalidReport,
  validationError,
}: {
  atlas: AtlasSnapshot;
  invalidReport: unknown;
  validationError: string;
}): AtlasReportMessage[] {
  const evidence = buildAtlasReportEvidence(atlas);
  return [
    {
      role: "system",
      content: [
        "You repair Vibez Atlas report JSON.",
        "Do not invent new facts. Use only supplied evidence refs.",
        "Return strict JSON only. No markdown.",
        "Do not use emoji, decorative symbols, or meme punctuation.",
        `The evidence window is ${atlas.window.hours} hours, from ${atlas.window.start} to ${atlas.window.end}. Use that window accurately; do not call it a week unless the evidence window is at least 120 hours.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Repair this Atlas newspaper issue so it satisfies the schema.",
        `This issue covers ${atlas.window.hours} hours. For this issue, do not write "this week", "weekly", or "week in review"; write "in this ${atlas.window.hours}-hour window", "over the latest window", or another accurate phrase.`,
        `Validation error: ${validationError}`,
        "Required invariants:",
        "- main_topic must be an object with title, paragraphs, and evidence_refs.",
        "- main_topic.title must be a non-empty string.",
        "- main_topic.paragraphs must contain exactly five short strings.",
        "- If main_topic.paragraphs has fewer than five strings, write the missing strings from the evidence pack.",
        "- The five main_topic paragraphs must be, in order: setup, what happened, what it means, why it matters, next move.",
        "- articles must contain exactly five items: one lead and four secondary items.",
        "- every article needs role, section, title, dek, summary, body, actions, evidence_refs, link_refs, channels, image, and related_article_slugs.",
        "- article sections must be plain text labels with no emoji or decorative symbols.",
        "- each article body must be an array with at least five compact paragraph objects; each object needs text and citation_refs.",
        "- at least the first four article paragraphs should include citation_refs from the evidence pack.",
        "- every article must include at least one valid evidence_refs citation from the evidence pack.",
        "- every article image must include kind, prompt, and alt; kind should be generated unless a real source image URL exists.",
        "- image prompts must describe a NYTimes-style documentary editorial photograph grounded in the article context, with dry clever nerd humor or nerd-meme references only when they serve the story. Avoid visible text, logos, cartoons, and glossy AI aesthetics.",
        "- If the invalid JSON has fewer than five valid articles, write enough complete secondary articles from the evidence pack to reach five.",
        "- use only refs present in the evidence pack.",
        "",
        "Required main_topic shape:",
        JSON.stringify(
          {
            title: "non-empty topic title",
            paragraphs: [
              "Setup paragraph.",
              "What happened paragraph.",
              "What it means paragraph.",
              "Why it matters paragraph.",
              "Next move paragraph.",
            ],
            evidence_refs: ["vibez:message:..."],
          },
          null,
          2,
        ),
        "",
        "Required minimum articles shape:",
        JSON.stringify(
          [
            {
              role: "lead",
              section: "Plain Theme Label",
              title: "non-empty title",
              dek: "non-empty deck",
              summary: "non-empty summary",
              body: [
                { text: "Reported opening paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Evidence paragraph with concrete source details.", citation_refs: ["vibez:message:..."] },
                { text: "Analysis paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Value paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Action paragraph.", citation_refs: ["vibez:message:..."] },
              ],
              actions: ["concrete action"],
              evidence_refs: ["vibez:message:..."],
              link_refs: [],
              channels: ["channel name"],
              image: { kind: "generated", prompt: "NYTimes-style documentary editorial photograph with dry clever nerd humor when useful", alt: "plain image description" },
              related_article_slugs: [],
            },
            {
              role: "secondary",
              section: "Plain Theme Label",
              title: "non-empty title",
              dek: "non-empty deck",
              summary: "non-empty summary",
              body: [
                { text: "Reported opening paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Evidence paragraph with concrete source details.", citation_refs: ["vibez:message:..."] },
                { text: "Analysis paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Value paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Action paragraph.", citation_refs: ["vibez:message:..."] },
              ],
              actions: ["concrete action"],
              evidence_refs: ["vibez:message:..."],
              link_refs: [],
              channels: ["channel name"],
              image: { kind: "generated", prompt: "NYTimes-style documentary editorial photograph with dry clever nerd humor when useful", alt: "plain image description" },
              related_article_slugs: [],
            },
            {
              role: "secondary",
              section: "Plain Theme Label",
              title: "non-empty title",
              dek: "non-empty deck",
              summary: "non-empty summary",
              body: [
                { text: "Reported opening paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Evidence paragraph with concrete source details.", citation_refs: ["vibez:message:..."] },
                { text: "Analysis paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Value paragraph.", citation_refs: ["vibez:message:..."] },
                { text: "Action paragraph.", citation_refs: ["vibez:message:..."] },
              ],
              actions: ["concrete action"],
              evidence_refs: ["vibez:message:..."],
              link_refs: [],
              channels: ["channel name"],
              image: { kind: "generated", prompt: "NYTimes-style documentary editorial photograph with dry clever nerd humor when useful", alt: "plain image description" },
              related_article_slugs: [],
            },
          ],
          null,
          2,
        ),
        "",
        "Invalid JSON:",
        JSON.stringify(invalidReport, null, 2),
        "",
        "Evidence pack:",
        JSON.stringify(evidence, null, 2),
      ].join("\n"),
    },
  ];
}

export function normalizeAtlasEditorialReport(
  raw: unknown,
  atlas: AtlasSnapshot,
): AtlasEditorialReport {
  if (!raw || typeof raw !== "object") {
    throw new Error("atlas editorial report is missing");
  }
  const payload = raw as Record<string, unknown>;
  const issuePayload = payload.issue && typeof payload.issue === "object"
    ? payload.issue as Record<string, unknown>
    : {};
  const headline = readText(payload.headline) || readText(payload.title) || readText(issuePayload.subtitle);
  const dek = readText(payload.dek) || readText(payload.subtitle) || readText(issuePayload.subtitle);
  if (!headline || !dek) {
    throw new Error("atlas editorial report is missing headline or dek");
  }

  const allowedRefs = new Set(Object.keys(atlas.citations));
  const report: AtlasEditorialReport = {
    issue: readIssue(payload.issue, atlas),
    headline,
    dek,
    what_happened: [],
    what_it_means: [],
    why_care: [],
    valuable: [],
    actions: [],
    main_topic: readMainTopic(payload.main_topic, allowedRefs, shellFallbackParagraphs(payload)),
    articles: [],
    briefs: readBriefs(payload.briefs, allowedRefs),
    crosscurrents: readCrosscurrents(payload.crosscurrents, allowedRefs),
    channel_reports: readChannelReports(payload.channel_reports, allowedRefs),
    themes: readThemes(payload.themes, allowedRefs),
    evidence: readEvidence(payload.evidence, allowedRefs),
    generated_at: new Date().toISOString(),
  };

  for (const field of REQUIRED_LIST_FIELDS) {
    report[field] = readTextList(payload[field]);
    if (report[field].length === 0) {
      throw new Error(`atlas editorial report is missing ${field}`);
    }
  }
  report.articles = readArticles(payload.articles, allowedRefs, report);

  return report;
}

function normalizeAtlasEditorialShell(
  raw: unknown,
  atlas: AtlasSnapshot,
): AtlasEditorialShell {
  if (!raw || typeof raw !== "object") {
    throw new Error("atlas editorial report is missing");
  }
  const payload = raw as Record<string, unknown>;
  const issuePayload = payload.issue && typeof payload.issue === "object"
    ? payload.issue as Record<string, unknown>
    : {};
  const headline = readText(payload.headline) || readText(payload.title) || readText(issuePayload.subtitle);
  const dek = readText(payload.dek) || readText(payload.subtitle) || readText(issuePayload.subtitle);
  if (!headline || !dek) {
    throw new Error("atlas editorial report is missing headline or dek");
  }

  const allowedRefs = new Set(Object.keys(atlas.citations));
  const articleSeeds = readArticleSeeds(payload.article_seeds, allowedRefs);
  if (
    articleSeeds.length !== 5 ||
    articleSeeds.filter((seed) => readText((seed as Record<string, unknown>).role) === "lead").length !== 1 ||
    articleSeeds.filter((seed) => readText((seed as Record<string, unknown>).role) === "secondary").length !== 4
  ) {
    throw new Error("atlas editorial shell must provide exactly one lead and four cited secondary article seeds");
  }
  const shell: AtlasEditorialShell = {
    issue: readIssue(payload.issue, atlas),
    headline,
    dek,
    what_happened: [],
    what_it_means: [],
    why_care: [],
    valuable: [],
    actions: [],
    main_topic: readMainTopic(payload.main_topic, allowedRefs, shellFallbackParagraphs(payload)),
    briefs: readBriefs(payload.briefs, allowedRefs),
    crosscurrents: readCrosscurrents(payload.crosscurrents, allowedRefs),
    channel_reports: readChannelReports(payload.channel_reports, allowedRefs),
    themes: readThemes(payload.themes, allowedRefs),
    evidence: readEvidence(payload.evidence, allowedRefs),
    article_seeds: articleSeeds,
  };

  for (const field of REQUIRED_LIST_FIELDS) {
    shell[field] = readTextList(payload[field]);
    if (shell[field].length === 0) {
      throw new Error(`atlas editorial report is missing ${field}`);
    }
  }

  return shell;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readText(item))
    .filter(Boolean)
    .slice(0, 6);
}

function uniqueTextList(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, 12);
}

function readArticleSeeds(value: unknown, allowedRefs: Set<string>): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map<Record<string, unknown> | null>((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as Record<string, unknown>;
      const role = readText(payload.role);
      const section = cleanSectionLabel(readText(payload.section));
      const title = readText(payload.title);
      const dek = readText(payload.dek);
      const evidenceRefs = readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref));
      if ((role !== "lead" && role !== "secondary") || !section || !title || !dek || evidenceRefs.length === 0) {
        return null;
      }
      return {
        ...payload,
        role,
        section,
        title,
        dek,
        evidence_refs: evidenceRefs,
        channels: readTextList(payload.channels),
      };
    })
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .slice(0, 6);
}

function readArticleBody(
  value: unknown,
  allowedRefs: Set<string>,
): { body: string[]; paragraphCitations: string[][] } {
  if (!Array.isArray(value)) return { body: [], paragraphCitations: [] };
  const body: string[] = [];
  const paragraphCitations: string[][] = [];
  for (const item of value) {
    let text = "";
    let citationRefs: string[] = [];
    if (typeof item === "string") {
      text = item;
    } else if (item && typeof item === "object") {
      const payload = item as Record<string, unknown>;
      text = readText(payload.text) || readText(payload.paragraph) || readText(payload.body);
      citationRefs = readTextList(payload.citation_refs).filter((ref) => allowedRefs.size === 0 || allowedRefs.has(ref));
    }
    const paragraph = cleanArticleParagraph(text);
    if (!paragraph || isArticlePlaceholder(paragraph)) continue;
    body.push(paragraph);
    paragraphCitations.push(uniqueTextList(citationRefs));
    if (body.length >= 6) break;
  }
  return { body, paragraphCitations };
}

function readIssue(value: unknown, atlas: AtlasSnapshot): AtlasEditorialIssue {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    date: readText(payload.date) || atlas.window.end.slice(0, 10),
    title: readText(payload.title) || "The Vibez Atlas",
    subtitle: readText(payload.subtitle) || readText(payload.dek) || "The latest field report.",
    edition_label: readText(payload.edition_label) || (atlas.window.hours >= 120 ? "Weekly Edition" : "Daily Edition"),
  };
}

function readThemes(value: unknown, allowedRefs: Set<string>): AtlasEditorialTheme[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as Record<string, unknown>;
      const title = readText(payload.title);
      const analysis = readText(payload.analysis);
      if (!title || !analysis) return null;
      return {
        title,
        analysis,
        evidence_refs: readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref)),
      };
    })
    .filter((item): item is AtlasEditorialTheme => Boolean(item))
    .slice(0, 6);
}

function readArticles(
  value: unknown,
  allowedRefs: Set<string>,
  report: Pick<AtlasEditorialReport, "headline" | "dek" | "main_topic" | "actions">,
): AtlasEditorialArticle[] {
  const rawItems = Array.isArray(value) ? value : [];
  const slugsByTitle = new Map<string, string>();
  const articles = rawItems
    .map((item, index) => readArticle(item, index, allowedRefs))
    .filter((item): item is AtlasEditorialArticle => Boolean(item))
    .slice(0, 6);

  if (rawItems.length > 0 && articles.length < 5) {
    throw new Error("atlas editorial report requires five newspaper articles with five cited paragraphs");
  }

  if (articles.length === 0) {
    articles.push({
      role: "lead",
      section: report.main_topic.title || "Atlas",
      title: report.main_topic.title || report.headline,
      slug: slugify(report.main_topic.title || report.headline),
      dek: report.dek,
      summary: report.main_topic.paragraphs[0] || report.dek,
      body: report.main_topic.paragraphs,
      paragraph_citations: report.main_topic.paragraphs.map(() => report.main_topic.evidence_refs),
      actions: report.actions,
      evidence_refs: report.main_topic.evidence_refs,
      link_refs: [],
      channels: [],
      image: { kind: "generated", prompt: `NYTimes-style documentary editorial photograph for ${report.headline}` },
      related_article_slugs: [],
    });
  }

  for (const article of articles) {
    const base = article.slug || slugify(article.title);
    const seen = slugsByTitle.get(base);
    if (!seen) {
      slugsByTitle.set(base, base);
      article.slug = base;
    } else {
      const nextSlug = `${base}-${slugsByTitle.size + 1}`;
      slugsByTitle.set(nextSlug, nextSlug);
      article.slug = nextSlug;
    }
  }

  const titleToSlug = new Map(articles.map((article) => [article.title.toLowerCase(), article.slug]));
  const slugSet = new Set(articles.map((article) => article.slug));
  for (const article of articles) {
    article.related_article_slugs = article.related_article_slugs
      .map((value) => titleToSlug.get(value.toLowerCase()) || slugify(value))
      .filter((slug) => slugSet.has(slug) && slug !== article.slug)
      .slice(0, 4);
  }

  if (!articles.some((article) => article.role === "lead")) {
    articles[0].role = "lead";
  }

  return articles;
}

function readArticle(
  value: unknown,
  index: number,
  allowedRefs: Set<string>,
): AtlasEditorialArticle | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const title = readText(payload.title);
  const dek = readText(payload.dek);
  const articleBody = readArticleBody(payload.body, allowedRefs);
  const body = articleBody.body;
  const role = readText(payload.role) === "lead" && index === 0 ? "lead" : "secondary";
  const evidenceRefs = uniqueTextList([
    ...readTextList(payload.evidence_refs),
    ...articleBody.paragraphCitations.flat(),
  ]).filter((ref) => allowedRefs.has(ref));
  if (!title || !dek || body.length < 5 || evidenceRefs.length === 0) return null;
  return {
    role,
    section: cleanSectionLabel(readText(payload.section)) || "Atlas",
    title,
    slug: slugify(readText(payload.slug) || title),
    dek,
    summary: readText(payload.summary) || body[0] || dek,
    body,
    paragraph_citations: articleBody.paragraphCitations,
    actions: readTextList(payload.actions),
    evidence_refs: evidenceRefs,
    link_refs: readTextList(payload.link_refs).filter((ref) => allowedRefs.has(ref)),
    channels: readTextList(payload.channels),
    image: readImage(payload.image, title),
    related_article_slugs: readTextList(payload.related_article_slugs),
  };
}

function cleanArticleParagraph(value: string): string {
  return value
    .replace(/^(paragraph\s+\d+|lead|evidence|analysis|value|action)(\s+paragraph)?\s*:\s*/i, "")
    .trim();
}

function isArticlePlaceholder(value: string): boolean {
  return /^(lead|evidence|analysis|value|action)(\s+paragraph)?\.?$/i.test(value) ||
    /^paragraph\s+\d+\.?$/i.test(value) ||
    /^a natural (reporting|evidence|analysis|value|action) paragraph/i.test(value);
}

function cleanSectionLabel(value: string): string {
  const cleaned = value
    .replace(/&[^;\s]+;/g, " ")
    .replace(/[^\p{L}\p{N}\s/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^ai[-\s]?oss$/i.test(cleaned)) return "AI OSS";
  if (/personal agents/i.test(cleaned)) return "Personal Agents";
  if (/personal workflows/i.test(cleaned)) return "Personal Workflows";
  if (/agentic weather/i.test(cleaned)) return "Agentic Weather";
  return cleaned;
}

function readImage(value: unknown, title: string): AtlasEditorialImage {
  if (!value || typeof value !== "object") {
    return { kind: "generated", prompt: `NYTimes-style documentary editorial photograph for ${title}` };
  }
  const payload = value as Record<string, unknown>;
  const rawKind = readText(payload.kind);
  const kind: AtlasEditorialImage["kind"] =
    rawKind === "link" || rawKind === "chat" || rawKind === "none" ? rawKind : "generated";
  return {
    kind,
    prompt: readText(payload.prompt) || undefined,
    url: readText(payload.url) || undefined,
    alt: readText(payload.alt) || undefined,
    status: readImageStatus(payload.status),
    error: readText(payload.error) || undefined,
    asset_key: readText(payload.asset_key) || undefined,
  };
}

function readImageStatus(value: unknown): AtlasEditorialImage["status"] | undefined {
  const status = readText(value);
  if (status === "pending" || status === "ready" || status === "failed" || status === "skipped") {
    return status;
  }
  return undefined;
}

function shellFallbackParagraphs(payload: Record<string, unknown>): string[] {
  return [
    ...readTextList(payload.what_happened),
    ...readTextList(payload.what_it_means),
    ...readTextList(payload.why_care),
    ...readTextList(payload.valuable),
    ...readTextList(payload.actions),
  ];
}

function readMainTopic(
  value: unknown,
  allowedRefs: Set<string>,
  fallbackParagraphs: string[] = [],
): AtlasEditorialMainTopic {
  if (!value || typeof value !== "object") {
    throw new Error("atlas editorial report is missing main_topic");
  }
  const payload = value as Record<string, unknown>;
  const title = readText(payload.title);
  const paragraphs = [...readTextList(payload.paragraphs), ...fallbackParagraphs].slice(0, 5);
  if (!title || paragraphs.length !== 5) {
    throw new Error("atlas editorial report main_topic requires a title and five paragraphs");
  }
  return {
    title,
    paragraphs,
    evidence_refs: readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref)),
  };
}

function readBriefs(value: unknown, allowedRefs: Set<string>): AtlasEditorialBrief[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as Record<string, unknown>;
      const title = readText(payload.title);
      const text = readText(payload.text);
      if (!title || !text) return null;
      return {
        title,
        text,
        evidence_refs: readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref)),
      };
    })
    .filter((item): item is AtlasEditorialBrief => Boolean(item))
    .slice(0, 6);
}

function readCrosscurrents(value: unknown, allowedRefs: Set<string>): AtlasEditorialCrosscurrent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as Record<string, unknown>;
      const title = readText(payload.title);
      const text = readText(payload.text);
      if (!title || !text) return null;
      return {
        title,
        text,
        channels: readTextList(payload.channels),
        evidence_refs: readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref)),
      };
    })
    .filter((item): item is AtlasEditorialCrosscurrent => Boolean(item))
    .slice(0, 5);
}

function readChannelReports(value: unknown, allowedRefs: Set<string>): AtlasEditorialChannelReport[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as Record<string, unknown>;
      const channel = readText(payload.channel);
      const headline = readText(payload.headline);
      const summary = readText(payload.summary);
      const whyItMatters = readText(payload.why_it_matters);
      const action = readText(payload.action);
      const evidenceRefs = readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref));
      if (!channel || !headline || !summary || !whyItMatters || !action || evidenceRefs.length === 0) return null;
      return {
        channel,
        headline,
        summary,
        why_it_matters: whyItMatters,
        action,
        evidence_refs: evidenceRefs,
      };
    })
    .filter((item): item is AtlasEditorialChannelReport => Boolean(item))
    .slice(0, 8);
}

function readEvidence(value: unknown, allowedRefs: Set<string>): AtlasEditorialEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as Record<string, unknown>;
      const ref = readText(payload.ref);
      const whyItMatters = readText(payload.why_it_matters);
      if (!ref || !allowedRefs.has(ref) || !whyItMatters) return null;
      return {
        ref,
        label: readText(payload.label) || ref,
        why_it_matters: whyItMatters,
      };
    })
    .filter((item): item is AtlasEditorialEvidence => Boolean(item))
    .slice(0, 10);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "article";
}
