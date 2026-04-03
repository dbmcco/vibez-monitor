import { getDb } from "@/lib/db";

export interface BriefingThread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

export interface BriefingContribution {
  theme: string;
  type: string;
  freshness: string;
  threads: string[];
  why: string;
  action: string;
  channel?: string;
  reply_to?: string;
  draft_message?: string;
  message_count: number;
}

export interface BriefingConversationArc {
  title?: string;
  participants?: string[];
  core_exchange?: string;
  why_it_matters?: string;
  likely_next?: string;
  how_to_add_value?: string;
}

export interface BriefingDeepDiveQuote {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

export interface BriefingThreadDeepDive {
  anchor: string | null;
  quotes: BriefingDeepDiveQuote[];
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "around",
  "being",
  "because",
  "between",
  "could",
  "daily",
  "from",
  "have",
  "into",
  "just",
  "more",
  "over",
  "their",
  "there",
  "these",
  "they",
  "this",
  "today",
  "using",
  "with",
]);

const GENERIC_THREAD_TERMS = new Set([
  "agent",
  "agents",
  "architecture",
  "architectures",
  "collaborator",
  "collaborators",
  "conversation",
  "conversations",
  "engine",
  "engines",
  "model",
  "models",
  "production",
  "system",
  "systems",
  "thread",
  "threads",
]);

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 5 && !STOPWORDS.has(token) && !GENERIC_THREAD_TERMS.has(token),
    );
}

function overlapCount(a: string[], b: string[]): number {
  const target = new Set(b);
  let overlap = 0;
  for (const token of a) {
    if (target.has(token)) overlap += 1;
  }
  return overlap;
}

function scoreContributionForThread(
  thread: BriefingThread,
  contribution: BriefingContribution,
): number {
  const titleText = normalizeMatchText(thread.title);
  const titleKeywords = extractKeywords(thread.title);
  const participantKeywords = thread.participants.flatMap((participant) => extractKeywords(participant));
  let score = 0;

  for (const ref of contribution.threads || []) {
    const refText = normalizeMatchText(ref);
    if (!refText) continue;
    if (titleText === refText) score += 10;
    else if (titleText.includes(refText) || refText.includes(titleText)) score += 6;
    score += overlapCount(titleKeywords, extractKeywords(ref)) * 2;
  }

  const supportText = [
    contribution.reply_to || "",
    contribution.why || "",
    contribution.action || "",
  ]
    .filter(Boolean)
    .join(" ");
  const supportKeywords = extractKeywords(supportText);
  score += overlapCount(titleKeywords, supportKeywords) * 3;
  score += overlapCount(participantKeywords, supportKeywords) * 2;
  return score;
}

function findContributionForThread(
  thread: BriefingThread,
  contributions: BriefingContribution[],
): BriefingContribution | null {
  let bestMatch: { contribution: BriefingContribution; score: number } | null = null;
  for (const contribution of contributions) {
    const score = scoreContributionForThread(thread, contribution);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { contribution, score };
    }
  }

  return bestMatch && bestMatch.score >= 6 ? bestMatch.contribution : null;
}

function findConversationArcForThread(
  thread: BriefingThread,
  arcs: BriefingConversationArc[],
): BriefingConversationArc | null {
  const titleText = normalizeMatchText(thread.title);
  const titleKeywords = extractKeywords(thread.title);
  if (!titleText && titleKeywords.length === 0) return null;

  for (const arc of arcs) {
    const arcTitle = normalizeMatchText(arc.title || "");
    if (titleText && arcTitle && (titleText.includes(arcTitle) || arcTitle.includes(titleText))) {
      return arc;
    }
    const arcKeywords = extractKeywords(arc.title || "");
    if (overlapCount(titleKeywords, arcKeywords) >= 2) {
      return arc;
    }
  }

  return null;
}

function buildSpecificKeywords(
  thread: BriefingThread,
  contribution: BriefingContribution | null,
  arc: BriefingConversationArc | null,
): string[] {
  return Array.from(
    new Set(
      [
        ...extractKeywords(thread.title),
        ...extractKeywords(contribution?.reply_to || ""),
        ...extractKeywords(arc?.core_exchange || ""),
        ...thread.participants.flatMap((participant) => extractKeywords(participant)),
      ],
    ),
  ).slice(0, 12);
}

function scoreMessage(
  message: BriefingDeepDiveQuote,
  participants: string[],
  preferredRoom: string | undefined,
  specificKeywords: string[],
): {
  score: number;
  keywordHits: number;
  participantMatch: boolean;
  roomMatch: boolean;
} {
  const body = message.body.toLowerCase();
  const room = (message.room_name || "").toLowerCase();
  const sender = (message.sender_name || "").toLowerCase();
  const roomMatch = Boolean(preferredRoom) && room === preferredRoom!.toLowerCase();
  const roomBonus =
    preferredRoom && room.includes(preferredRoom.toLowerCase()) ? (roomMatch ? 6 : 3) : 0;
  let participantMatch = false;
  const participantBonus = participants.reduce((score, participant) => {
    const normalized = participant.trim().toLowerCase();
    if (!normalized) return score;
    if (sender === normalized) {
      participantMatch = true;
      return score + 8;
    }
    if (body.includes(normalized)) return score + 2;
    return score;
  }, 0);
  const keywordHits = specificKeywords.reduce(
    (score, keyword) => (body.includes(keyword) ? score + 1 : score),
    0,
  );
  const relevance = message.relevance_score ?? 0;
  return {
    score: roomBonus + participantBonus + keywordHits * 3 + relevance,
    keywordHits,
    participantMatch,
    roomMatch,
  };
}

function selectQuotes(
  messages: BriefingDeepDiveQuote[],
  thread: BriefingThread,
  contribution: BriefingContribution | null,
  arc: BriefingConversationArc | null,
): BriefingDeepDiveQuote[] {
  const specificKeywords = buildSpecificKeywords(thread, contribution, arc);
  const participants = thread.participants || [];
  const preferredRoom = contribution?.channel;
  const seen = new Set<string>();
  const senderCounts = new Map<string, number>();

  return [...messages]
    .filter((message) => (message.body || "").trim().length >= 80)
    .map((message) => ({
      message,
      ...scoreMessage(message, participants, preferredRoom, specificKeywords),
    }))
    .filter(({ score, keywordHits, participantMatch, roomMatch }) => {
      if (participantMatch && roomMatch && keywordHits >= 1) return true;
      if (participantMatch && keywordHits >= 2) return true;
      if (roomMatch && keywordHits >= 2) return true;
      return score >= 14 && keywordHits >= 3;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.message.timestamp - a.message.timestamp;
    })
    .map(({ message }) => message)
    .filter((message) => {
      const body = message.body.trim().toLowerCase();
      const sender = (message.sender_name || "Unknown").trim();
      const senderCount = senderCounts.get(sender) || 0;
      if (!body || seen.has(body) || senderCount >= 2) return false;
      seen.add(body);
      senderCounts.set(sender, senderCount + 1);
      return true;
    })
    .slice(0, 3);
}

function queryParticipantMessages(
  participantNames: string[],
  lookbackDays: number,
  limit: number,
  preferredRoom?: string,
): BriefingDeepDiveQuote[] {
  if (participantNames.length === 0) return [];

  const db = getDb();
  const cutoffTs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const whereParts = ["m.timestamp >= ?"];
  const params: unknown[] = [cutoffTs];

  whereParts.push(`LOWER(m.sender_name) IN (${participantNames.map(() => "?").join(", ")})`);
  params.push(...participantNames);

  if (preferredRoom) {
    whereParts.push("LOWER(m.room_name) = ?");
    params.push(preferredRoom.toLowerCase());
  }

  const rows = db
    .prepare(
      `SELECT m.*, c.relevance_score, c.topics, c.entities,
              c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE ${whereParts.join(" AND ")}
       ORDER BY m.timestamp DESC
       LIMIT ?`,
    )
    .all(...params, limit) as BriefingDeepDiveQuote[];
  db.close();
  return rows;
}

function fetchThreadCandidateMessages(
  thread: BriefingThread,
  contribution: BriefingContribution | null,
): BriefingDeepDiveQuote[] {
  const participants = Array.from(
    new Set(
      thread.participants
        .map((participant) => participant.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (participants.length === 0) return [];

  const roomScoped = queryParticipantMessages(participants, 21, 18, contribution?.channel);
  const broad = queryParticipantMessages(participants, 21, 36);
  const seen = new Set<string>();
  return [...roomScoped, ...broad].filter((message) => {
    if (!message?.id || seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function buildBriefingThreadDeepDiveData(raw: {
  briefing_json: string | null;
  contributions: string | null;
  conversation_arcs: string | null;
}): Record<string, BriefingThreadDeepDive> {
  const threads = parseJson<BriefingThread[]>(raw.briefing_json, []);
  const contributions = parseJson<BriefingContribution[]>(raw.contributions, []);
  const arcs = parseJson<BriefingConversationArc[]>(raw.conversation_arcs, []);

  const entries = threads.map((thread, index) => {
    const key = `${thread.title}-${index}`;
    const contribution = findContributionForThread(thread, contributions);
    const arc = findConversationArcForThread(thread, arcs);
    const anchor = contribution?.reply_to || arc?.core_exchange || thread.insights || null;
    const messages = fetchThreadCandidateMessages(thread, contribution);
    const quotes = selectQuotes(messages, thread, contribution, arc);
    return [key, { anchor, quotes }] as const;
  });

  return Object.fromEntries(entries);
}
