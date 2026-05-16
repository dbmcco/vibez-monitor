import { searchLinks, searchMessages, type LinkRow, type Message } from "./db";
import { generateJson } from "./model-router";
import { isPgvectorEnabled } from "./semantic";
import type { AtlasEditorialArticle } from "./atlas-report";

export interface AtlasDeeperDiveInput {
  article: AtlasEditorialArticle;
  hours?: number;
}

export interface AtlasDeeperDive {
  title: string;
  claim_under_review: string;
  retrieval_mode: "semantic" | "keyword_fallback";
  supporting_evidence: string[];
  counterevidence: string[];
  weak_spots: string[];
  alternative_interpretations: string[];
  recommended_actions: string[];
  citation_refs: string[];
  generated_at: string;
}

interface AtlasDeeperDiveDeps {
  searchMessages: typeof searchMessages;
  searchLinks: typeof searchLinks;
  generateJson: typeof generateJson<unknown>;
  isSemanticEnabled: () => boolean;
}

interface AtlasDeeperDiveMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const defaultDeps: AtlasDeeperDiveDeps = {
  searchMessages,
  searchLinks,
  generateJson: generateJson<unknown>,
  isSemanticEnabled: isPgvectorEnabled,
};

export async function generateAtlasDeeperDive(
  input: AtlasDeeperDiveInput,
  deps: AtlasDeeperDiveDeps = defaultDeps,
): Promise<AtlasDeeperDive> {
  const hours = Math.max(6, Math.min(input.hours || 48, 168));
  const query = buildArticleQuery(input.article);
  const [messages, links] = await Promise.all([
    deps.searchMessages({
      query,
      lookbackDays: Math.ceil(hours / 24),
      limit: 20,
    }),
    deps.searchLinks({
      query,
      days: 7,
      limit: 12,
      sort: "value",
    }),
  ]);
  const retrievalMode = deps.isSemanticEnabled() ? "semantic" : "keyword_fallback";
  const result = await deps.generateJson({
    taskId: "dashboard.atlas_deeper_dive",
    messages: buildDeeperDiveMessages({
      article: input.article,
      messages,
      links,
      retrievalMode,
    }),
  });
  return normalizeDeeperDive(result.parsed, {
    retrievalMode,
    allowedRefs: new Set([
      ...input.article.evidence_refs,
      ...input.article.link_refs,
      ...messages.map((message) => messageRef(message.id)),
      ...links.map((link) => linkRef(link.id)),
    ]),
  });
}

function buildArticleQuery(article: AtlasEditorialArticle): string {
  return [
    article.title,
    article.dek,
    article.summary,
    article.channels.join(" "),
    article.body.slice(0, 2).join(" "),
  ].filter(Boolean).join("\n");
}

function buildDeeperDiveMessages(input: {
  article: AtlasEditorialArticle;
  messages: Message[];
  links: LinkRow[];
  retrievalMode: AtlasDeeperDive["retrieval_mode"];
}): AtlasDeeperDiveMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are an adversarial analyst for Vibez Atlas.",
        "Challenge the article without being contrarian for sport.",
        "Use the retrieved evidence. Do not invent facts.",
        "Return strict JSON only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Run a deeper dive on this Atlas article.",
        "Test the claim, find supporting evidence, find counterevidence, name weak spots, offer alternative interpretations, and recommend next actions.",
        "",
        "Return strict JSON with this shape:",
        JSON.stringify(
          {
            title: "short deeper dive title",
            claim_under_review: "the article claim being tested",
            supporting_evidence: ["what supports the claim"],
            counterevidence: ["what challenges or complicates the claim"],
            weak_spots: ["missing evidence or weak assumptions"],
            alternative_interpretations: ["other plausible readings"],
            recommended_actions: ["specific follow-up actions"],
            citation_refs: ["vibez:message:...", "vibez:link:..."],
          },
          null,
          2,
        ),
        "",
        "Retrieval mode:",
        input.retrievalMode,
        "",
        "Article:",
        JSON.stringify(input.article, null, 2),
        "",
        "Retrieved messages:",
        JSON.stringify(input.messages.map(messageToEvidence), null, 2),
        "",
        "Retrieved links:",
        JSON.stringify(input.links.map(linkToEvidence), null, 2),
      ].join("\n"),
    },
  ];
}

function normalizeDeeperDive(
  raw: unknown,
  context: {
    retrievalMode: AtlasDeeperDive["retrieval_mode"];
    allowedRefs: Set<string>;
  },
): AtlasDeeperDive {
  if (!raw || typeof raw !== "object") {
    throw new Error("atlas deeper dive is missing");
  }
  const payload = raw as Record<string, unknown>;
  const title = readText(payload.title);
  const claim = readText(payload.claim_under_review);
  if (!title || !claim) {
    throw new Error("atlas deeper dive is missing title or claim");
  }
  const dive: AtlasDeeperDive = {
    title,
    claim_under_review: claim,
    retrieval_mode: context.retrievalMode,
    supporting_evidence: readList(payload.supporting_evidence),
    counterevidence: readList(payload.counterevidence),
    weak_spots: readList(payload.weak_spots),
    alternative_interpretations: readList(payload.alternative_interpretations),
    recommended_actions: readList(payload.recommended_actions),
    citation_refs: readList(payload.citation_refs).filter((ref) => context.allowedRefs.has(ref)),
    generated_at: new Date().toISOString(),
  };
  for (const field of [
    "supporting_evidence",
    "counterevidence",
    "weak_spots",
    "alternative_interpretations",
    "recommended_actions",
  ] as const) {
    if (dive[field].length === 0) {
      throw new Error(`atlas deeper dive is missing ${field}`);
    }
  }
  return dive;
}

function messageToEvidence(message: Message) {
  return {
    ref: messageRef(message.id),
    label: `${message.sender_name} in ${message.room_name}`,
    channel: message.room_name,
    sender: message.sender_name,
    timestamp: message.timestamp,
    relevance_score: message.relevance_score,
    text: message.body,
  };
}

function linkToEvidence(link: LinkRow) {
  return {
    ref: linkRef(link.id),
    title: link.title || link.url,
    url: link.url,
    relevance: link.relevance,
    shared_by: link.shared_by,
    source_group: link.source_group,
  };
}

function messageRef(id: string): string {
  return `vibez:message:${id}`;
}

function linkRef(id: number | string): string {
  return `vibez:link:${id}`;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readText(item)).filter(Boolean).slice(0, 8);
}
