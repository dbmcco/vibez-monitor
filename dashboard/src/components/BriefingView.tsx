"use client";

import { useMemo, useState } from "react";

interface Thread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

interface Contribution {
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

interface TrendData {
  emerging?: string[];
  fading?: string[];
  shifts?: string;
}

interface EvidenceMessage {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

interface Props {
  briefing_json: string | null;
  contributions_json?: string | null;
  trends: string | null;
  report_date: string;
  evidence_messages?: EvidenceMessage[];
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "agent",
  "agents",
  "around",
  "being",
  "because",
  "between",
  "could",
  "daily",
  "from",
  "have",
  "house",
  "into",
  "just",
  "more",
  "over",
  "their",
  "there",
  "these",
  "they",
  "this",
  "thread",
  "today",
  "using",
  "with",
]);

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function freshnessBadge(freshness: string): { color: string; label: string } {
  switch (freshness.toLowerCase()) {
    case "hot":
      return { color: "badge-hot", label: "hot" };
    case "warm":
      return { color: "badge-warm", label: "warm" };
    case "cool":
      return { color: "badge-cool", label: "cool" };
    default:
      return { color: "badge-archive", label: freshness || "archive" };
  }
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi);
  return matches ? matches : [];
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function excerpt(text: string, maxLength = 260): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatTs(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function buildExecutiveTakeaways(threads: Thread[], trendData: TrendData): string[] {
  const takeaways: string[] = [];
  if (trendData.shifts) takeaways.push(trendData.shifts);
  if (trendData.emerging && trendData.emerging.length > 0) {
    takeaways.push(
      `Emerging: ${trendData.emerging
        .slice(0, 3)
        .map((item) => item.replace(/\.\.\.$/, ""))
        .join(", ")}.`,
    );
  }
  for (const thread of threads.slice(0, 3)) {
    const participants = thread.participants.slice(0, 4).join(", ");
    takeaways.push(
      `${thread.title}: ${thread.insights} ${participants ? `(Participants: ${participants})` : ""}`,
    );
  }
  if (takeaways.length === 0) {
    takeaways.push("No structured executive data is available for this reporting window.");
  }
  return takeaways.map((item) => item.trim());
}

function pickEvidenceQuotes(messages: EvidenceMessage[], threads: Thread[]): EvidenceMessage[] {
  const keywordSet = new Set<string>(
    threads
      .flatMap((thread) => [thread.title, thread.insights].flatMap(extractKeywords))
      .slice(0, 180),
  );
  const senderCounts = new Map<string, number>();
  const now = Date.now();
  return [...messages]
    .filter((message) => {
      if (!message?.body) return false;
      const sender = (message.sender_name || "").toLowerCase();
      if (sender.includes("whatsappbot")) return false;
      const text = message.body.trim();
      if (text.length < 80) return false;
      if (/^https?:\/\//i.test(text)) return false;
      return true;
    })
    .map((message) => {
      const text = message.body.toLowerCase();
      const keywordHits = Array.from(keywordSet).reduce(
        (sum, token) => (text.includes(token) ? sum + 1 : sum),
        0,
      );
      const recencyHours = Math.max(0, (now - Number(message.timestamp || now)) / 36e5);
      const recencyBonus = Math.max(0, 24 - recencyHours) * 0.12;
      const relevance = message.relevance_score ?? 0;
      const score = relevance * 2 + keywordHits * 0.9 + recencyBonus;
      return { message, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ message }) => {
      const sender = message.sender_name || "Unknown";
      const count = senderCounts.get(sender) || 0;
      if (count >= 2) return false;
      senderCounts.set(sender, count + 1);
      return true;
    })
    .slice(0, 6)
    .map((entry) => entry.message);
}

function collectReferences(threads: Thread[], quotes: EvidenceMessage[]): string[] {
  const links: string[] = [];
  for (const thread of threads) {
    links.push(...thread.links);
  }
  for (const quote of quotes) {
    links.push(...extractUrls(quote.body));
  }
  const deduped = Array.from(new Set(links.map((link) => link.trim()).filter(Boolean)));
  return deduped.slice(0, 14);
}

export function BriefingView({
  briefing_json,
  contributions_json,
  trends,
  report_date,
  evidence_messages = [],
}: Props) {
  const threads = parseJson<Thread[]>(briefing_json, []);
  const contributions = parseJson<Contribution[]>(contributions_json, []);
  const trendData = parseJson<TrendData>(trends, {});
  const [showAllContributions, setShowAllContributions] = useState(false);

  const executiveTakeaways = useMemo(
    () => buildExecutiveTakeaways(threads, trendData),
    [threads, trendData],
  );
  const evidenceQuotes = useMemo(
    () => pickEvidenceQuotes(evidence_messages, threads),
    [evidence_messages, threads],
  );
  const references = useMemo(
    () => collectReferences(threads, evidenceQuotes),
    [threads, evidenceQuotes],
  );
  const visibleContributions = showAllContributions
    ? contributions
    : contributions.slice(0, 3);

  return (
    <div className="space-y-8">
      <header className="fade-up space-y-2">
        <p className="text-xs font-medium tracking-[0.16em] text-cyan-300/90 uppercase">
          Executive Briefing
        </p>
        <h2 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          AGI Community Pulse <span className="text-cyan-200/90">— {report_date}</span>
        </h2>
        <p className="vibe-subtitle max-w-3xl">
          Priority signals, validated evidence, and practical references from the community.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="vibe-panel rounded-xl p-5">
          <h3 className="vibe-title text-lg text-slate-100">Executive Snapshot</h3>
          <div className="mt-3 space-y-2 text-sm text-slate-200">
            {executiveTakeaways.slice(0, 5).map((takeaway, index) => (
              <p key={`${takeaway}-${index}`} className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                {takeaway}
              </p>
            ))}
          </div>
        </article>
        <article className="vibe-panel rounded-xl p-5">
          <h3 className="vibe-title text-lg text-slate-100">Thread Priorities</h3>
          <div className="mt-3 space-y-3">
            {threads.slice(0, 5).map((thread, index) => (
              <div key={`${thread.title}-${index}`} className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                <p className="text-sm font-semibold text-slate-100">{thread.title}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {thread.participants.slice(0, 6).join(", ") || "Participants not listed"}
                </p>
              </div>
            ))}
            {threads.length === 0 && (
              <p className="text-sm text-slate-400">No thread priorities available for this date.</p>
            )}
          </div>
        </article>
      </section>

      {(evidenceQuotes.length > 0 || references.length > 0) && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">Evidence, Quotes, and References</h3>
          {evidenceQuotes.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2">
              {evidenceQuotes.map((quote) => (
                <article key={quote.id} className="vibe-panel rounded-xl p-5">
                  <p className="text-sm leading-relaxed text-slate-100">“{excerpt(quote.body)}”</p>
                  <p className="mt-3 text-xs text-slate-400">
                    {quote.sender_name} · {quote.room_name} · {formatTs(quote.timestamp)}
                  </p>
                </article>
              ))}
            </div>
          )}
          {references.length > 0 && (
            <div className="vibe-panel rounded-xl p-5">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Source Links
              </p>
              <div className="mt-3 grid gap-2">
                {references.map((link, index) => (
                  <a
                    key={`${link}-${index}`}
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm break-all text-cyan-300 hover:text-cyan-100"
                  >
                    {hostname(link)} — {link}
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="space-y-4">
        <h3 className="vibe-title text-lg text-slate-100">Key Threads</h3>
        {threads.length === 0 ? (
          <div className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
            No briefing available for this date.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {threads.map((thread, i) => (
              <article key={`${thread.title}-${i}`} className="vibe-panel fade-up rounded-xl p-5">
                <h4 className="vibe-title text-base text-slate-100">{thread.title}</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {thread.participants.map((participant) => (
                    <span
                      key={`${thread.title}-${participant}`}
                      className="vibe-chip rounded px-2 py-0.5 text-xs"
                    >
                      {participant}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">{thread.insights}</p>
                {thread.links.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {thread.links.map((link, j) => (
                      <a
                        key={`${thread.title}-${j}`}
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs break-all text-cyan-300 hover:text-cyan-100"
                      >
                        {link}
                      </a>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {contributions.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="vibe-title text-lg text-slate-100">Optional Contribution Moves</h3>
            {contributions.length > 3 && (
              <button
                onClick={() => setShowAllContributions((prev) => !prev)}
                className="rounded border border-slate-600/70 bg-slate-900/50 px-2.5 py-1 text-xs text-slate-200 hover:border-cyan-300/60"
              >
                {showAllContributions
                  ? "Show fewer contribution options"
                  : `Show all ${contributions.length} contribution options`}
              </button>
            )}
          </div>
          <div className="grid gap-4">
            {visibleContributions.map((contribution, i) => {
              const badge = freshnessBadge(contribution.freshness);
              return (
                <article
                  key={`${contribution.theme}-${i}`}
                  className="vibe-panel fade-up rounded-xl p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-emerald-300">
                      {contribution.theme}
                    </span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge.color}`}>
                      {badge.label}
                    </span>
                    <span className="vibe-chip rounded px-2 py-0.5 text-xs">
                      {contribution.type}
                    </span>
                    {contribution.message_count > 0 && (
                      <span className="text-xs text-slate-400">
                        {contribution.message_count} msgs
                      </span>
                    )}
                  </div>

                  {(contribution.channel || contribution.reply_to) && (
                    <div className="mt-3 rounded-lg border border-slate-700/70 bg-slate-900/65 p-3">
                      {contribution.channel && (
                        <p className="text-sm text-slate-200">
                          <span className="mr-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                            Channel
                          </span>
                          {contribution.channel}
                        </p>
                      )}
                      {contribution.reply_to && (
                        <p className="mt-1 text-sm text-slate-300">
                          <span className="mr-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                            Reply To
                          </span>
                          {contribution.reply_to}
                        </p>
                      )}
                    </div>
                  )}

                  <p className="mt-3 text-sm leading-relaxed text-slate-300">{contribution.why}</p>
                  <p className="mt-2 text-sm font-medium text-emerald-200/95">{contribution.action}</p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {(trendData.emerging?.length || trendData.fading?.length || trendData.shifts) && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">Trend Direction</h3>
          <div className="vibe-panel rounded-xl p-5">
            {trendData.emerging && trendData.emerging.length > 0 && (
              <p className="text-sm text-emerald-300">
                <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-emerald-400/90">
                  Emerging
                </span>
                {trendData.emerging.join(", ")}
              </p>
            )}
            {trendData.fading && trendData.fading.length > 0 && (
              <p className="mt-2 text-sm text-slate-400">
                <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-slate-500">
                  Fading
                </span>
                {trendData.fading.join(", ")}
              </p>
            )}
            {trendData.shifts && (
              <p className="mt-3 text-sm leading-relaxed text-slate-300">{trendData.shifts}</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
