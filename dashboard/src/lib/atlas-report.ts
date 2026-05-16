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

export interface AtlasEditorialReport {
  headline: string;
  dek: string;
  what_happened: string[];
  what_it_means: string[];
  why_care: string[];
  valuable: string[];
  actions: string[];
  main_topic: AtlasEditorialMainTopic;
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
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write the latest Atlas report from this evidence pack.",
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
    headline,
    dek,
    what_happened: [],
    what_it_means: [],
    why_care: [],
    valuable: [],
    actions: [],
    main_topic: readMainTopic(payload.main_topic, allowedRefs),
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
