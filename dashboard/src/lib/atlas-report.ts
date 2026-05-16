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
}

export interface AtlasEditorialArticle {
  role: "lead" | "secondary";
  title: string;
  slug: string;
  dek: string;
  summary: string;
  body: string[];
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
  themes: AtlasEditorialTheme[];
  evidence: AtlasEditorialEvidence[];
  generated_at: string;
}

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
        "You are the editor and analyst for Vibez Atlas.",
        "Write in a human, first-class reporting voice. Follow Strunk and White: concrete nouns, active verbs, short sentences, omit needless words.",
        "Use some wit when it clarifies the point, but do not be glib.",
        "Do not invent facts. Tie every major claim to the supplied citation refs.",
        "The reader wants analysis, not a pile of links.",
        "You are creating a daily newspaper issue, not a single-theme dashboard summary.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write the latest Atlas report from this evidence pack as a daily newspaper issue.",
        "Do not reduce the day to one theme unless the evidence truly supports that. Prefer one lead story plus several first-class side stories.",
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
                "exactly five short paragraphs: setup, what happened, what it means, why it matters, next move",
              ],
              evidence_refs: ["vibez:message:..."],
            },
            articles: [
              {
                role: "lead",
                title: "front-page article title",
                dek: "one sentence article deck",
                summary: "two sentence article card summary",
                body: ["five or more paragraphs for the full article page"],
                actions: ["concrete next action"],
                evidence_refs: ["vibez:message:..."],
                link_refs: ["vibez:link:..."],
                channels: ["channel name"],
                image: {
                  kind: "generated",
                  prompt: "editorial image prompt grounded in the article",
                },
                related_article_slugs: ["related article title or slug"],
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
  const result = await generator({
    taskId: "dashboard.atlas_report",
    messages: buildAtlasReportMessages(atlas),
  });
  return normalizeAtlasEditorialReport(result.parsed, atlas);
}

export function normalizeAtlasEditorialReport(
  raw: unknown,
  atlas: AtlasSnapshot,
): AtlasEditorialReport {
  if (!raw || typeof raw !== "object") {
    throw new Error("atlas editorial report is missing");
  }
  const payload = raw as Record<string, unknown>;
  const headline = readText(payload.headline);
  const dek = readText(payload.dek);
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
    main_topic: readMainTopic(payload.main_topic, allowedRefs),
    articles: [],
    briefs: readBriefs(payload.briefs, allowedRefs),
    crosscurrents: readCrosscurrents(payload.crosscurrents, allowedRefs),
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

  if (articles.length === 0) {
    articles.push({
      role: "lead",
      title: report.main_topic.title || report.headline,
      slug: slugify(report.main_topic.title || report.headline),
      dek: report.dek,
      summary: report.main_topic.paragraphs[0] || report.dek,
      body: report.main_topic.paragraphs,
      actions: report.actions,
      evidence_refs: report.main_topic.evidence_refs,
      link_refs: [],
      channels: [],
      image: { kind: "generated", prompt: `Editorial illustration for ${report.headline}` },
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
  const body = readTextList(payload.body).slice(0, 8);
  if (!title || !dek || body.length < 3) return null;
  const role = readText(payload.role) === "lead" && index === 0 ? "lead" : "secondary";
  const evidenceRefs = readTextList(payload.evidence_refs).filter((ref) => allowedRefs.has(ref));
  return {
    role,
    title,
    slug: slugify(readText(payload.slug) || title),
    dek,
    summary: readText(payload.summary) || body[0] || dek,
    body,
    actions: readTextList(payload.actions),
    evidence_refs: evidenceRefs,
    link_refs: readTextList(payload.link_refs).filter((ref) => allowedRefs.has(ref)),
    channels: readTextList(payload.channels),
    image: readImage(payload.image, title),
    related_article_slugs: readTextList(payload.related_article_slugs),
  };
}

function readImage(value: unknown, title: string): AtlasEditorialImage {
  if (!value || typeof value !== "object") {
    return { kind: "generated", prompt: `Editorial newspaper image for ${title}` };
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
  };
}

function readMainTopic(value: unknown, allowedRefs: Set<string>): AtlasEditorialMainTopic {
  if (!value || typeof value !== "object") {
    throw new Error("atlas editorial report is missing main_topic");
  }
  const payload = value as Record<string, unknown>;
  const title = readText(payload.title);
  const paragraphs = readTextList(payload.paragraphs).slice(0, 5);
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
