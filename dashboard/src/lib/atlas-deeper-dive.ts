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
  research_question: string;
  retrieval_mode: "semantic";
  what_else_was_said: string[];
  why_it_matters: string[];
  patterns: string[];
  tensions: string[];
  open_questions: string[];
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
  if (!deps.isSemanticEnabled()) {
    throw new Error("semantic retrieval is required for Atlas research dives");
  }
  const lookbackDays = 30;
  const query = buildArticleQuery(input.article);
  const [messages, links] = await Promise.all([
    deps.searchMessages({
      query,
      lookbackDays,
      limit: 80,
      semanticOnly: true,
    }),
    deps.searchLinks({
      query,
      days: lookbackDays,
      limit: 40,
      sort: "value",
      semanticOnly: true,
    }).catch((error) => {
      console.warn("atlas deeper-dive link retrieval failed:", error);
      return [];
    }),
  ]);
  if (messages.length === 0) {
    throw new Error("semantic retrieval returned no messages for this research dive");
  }
  const retrievalMode = "semantic";
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
        "You are a research editor for Vibez Atlas.",
        "The supplied article is only a seed. Do not grade, rewrite, fact-check, or summarize the article as the main job.",
        "Your job is to synthesize what the wider AGI practitioner community has said about this kind of topic across the retrieved channel evidence.",
        "Write with humane, sharp newsroom judgment: clear, useful, lightly witty when the evidence supports it, never glib.",
        "Use retrieved evidence and citations. Do not invent facts.",
        "Return strict JSON only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Write a follow-on research report seeded by this Atlas article.",
        "Search meaning: the retrieval system already searched the broader AGI channel corpus semantically. Your job is synthesis, not article review.",
        "Explain what else has been said about this kind of thing, why it matters, what patterns are emerging, what tensions or disagreements exist, what remains unknown, and what a community member should do next.",
        "Refer to people as community members or practitioners, not users.",
        "Make the report valuable to someone trying to understand the community's thinking.",
        "",
        "Return strict JSON with this shape:",
        JSON.stringify(
          {
            title: "short research report title",
            research_question: "the broader question raised by the seed article",
            what_else_was_said: ["synthesis of related channel evidence"],
            why_it_matters: ["why the pattern matters to practitioners"],
            patterns: ["recurring themes, behaviors, or shifts"],
            tensions: ["disagreements, tradeoffs, or unresolved conflicts"],
            open_questions: ["important unknowns or missing evidence"],
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
  const researchQuestion = readText(payload.research_question);
  if (!title || !researchQuestion) {
    throw new Error("atlas research dive is missing title or research question");
  }
  const dive: AtlasDeeperDive = {
    title,
    research_question: researchQuestion,
    retrieval_mode: context.retrievalMode,
    what_else_was_said: readList(payload.what_else_was_said),
    why_it_matters: readList(payload.why_it_matters),
    patterns: readList(payload.patterns),
    tensions: readList(payload.tensions),
    open_questions: readList(payload.open_questions),
    recommended_actions: readList(payload.recommended_actions),
    citation_refs: readList(payload.citation_refs).filter((ref) => context.allowedRefs.has(ref)),
    generated_at: new Date().toISOString(),
  };
  for (const field of [
    "what_else_was_said",
    "why_it_matters",
    "patterns",
    "tensions",
    "open_questions",
    "recommended_actions",
  ] as const) {
    if (dive[field].length === 0) {
      throw new Error(`atlas research dive is missing ${field}`);
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
