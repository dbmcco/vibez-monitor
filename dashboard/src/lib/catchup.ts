// ABOUTME: Catchup feature — SQLite cache helpers, daily report fetching, prompt builder, synthesis.
// ABOUTME: Server-only. Called by /api/catchup. Uses better-sqlite3 and @anthropic-ai/sdk.

import Database from "better-sqlite3";
import path from "path";

import { generateText } from "@/lib/model-router";

const DB_PATH =
  process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

const CATCHUP_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS catchup_cache (
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (start_date, end_date)
);
`;

function withWriteDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(CATCHUP_CACHE_SCHEMA);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export interface CatchupArc {
  title: string;
  participants: string[];
  core_exchange: string;
  why_it_matters: string;
  likely_next: string;
}

export interface CatchupLink {
  url: string;
  title: string;
  category: string;
  relevance: string;
}

export interface CatchupResult {
  catchup_memo: string;
  conversation_arcs: CatchupArc[];
  themes: string[];
  trends: {
    emerging: string[];
    fading: string[];
    shifts: string;
  };
  links: CatchupLink[];
  people_activity: Array<{ name: string; role: string }>;
  unresolved_threads: Array<{ title: string; status: string }>;
  hot_on_return: Array<{ title: string; why_hot: string }>;
}

const EMPTY_RESULT: CatchupResult = {
  catchup_memo: "",
  conversation_arcs: [],
  themes: [],
  trends: { emerging: [], fading: [], shifts: "" },
  links: [],
  people_activity: [],
  unresolved_threads: [],
  hot_on_return: [],
};

export function getCatchupCache(
  startDate: string,
  endDate: string
): CatchupResult | null {
  return withWriteDb((db) => {
    const row = db
      .prepare(
        "SELECT result_json FROM catchup_cache WHERE start_date = ? AND end_date = ? AND stale = 0"
      )
      .get(startDate, endDate) as { result_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.result_json) as CatchupResult;
    } catch {
      return null;
    }
  });
}

export function setCatchupCache(
  startDate: string,
  endDate: string,
  result: CatchupResult
): void {
  withWriteDb((db) => {
    db.prepare(
      `INSERT OR REPLACE INTO catchup_cache (start_date, end_date, result_json, created_at, stale)
       VALUES (?, ?, ?, ?, 0)`
    ).run(startDate, endDate, JSON.stringify(result), Date.now());
  });
}

interface DailyReportRow {
  report_date: string;
  daily_memo: string | null;
  conversation_arcs: string | null;
  trends: string | null;
  stats: string | null; // stores links[] per save_daily_report convention
}

export function getReportsForRange(
  startDate: string,
  endDate: string
): DailyReportRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");
  try {
    return db
      .prepare(
        `SELECT report_date, daily_memo, conversation_arcs, trends, stats
         FROM daily_reports
         WHERE report_date >= ? AND report_date <= ?
         ORDER BY report_date ASC`
      )
      .all(startDate, endDate) as DailyReportRow[];
  } finally {
    db.close();
  }
}

function allDatesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function tryParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function buildCatchupPrompt(
  reports: DailyReportRow[],
  startDate: string,
  endDate: string
): string {
  const dates = allDatesInRange(startDate, endDate);
  const byDate = new Map(reports.map((r) => [r.report_date, r]));
  const lastDate = dates[dates.length - 1];
  const nDays = dates.length;

  const daysBlock = dates
    .map((date) => {
      const r = byDate.get(date);
      if (!r) return `[${date}]\nNo data available for this date.\n`;

      const arcs = tryParseJson<Array<{ title?: string; participants?: string[] }>>(
        r.conversation_arcs,
        []
      );
      const trends = tryParseJson<{
        emerging?: string[];
        fading?: string[];
        shifts?: string;
      }>(r.trends, {});
      const links = tryParseJson<Array<{ title?: string; url?: string }>>(
        r.stats,
        []
      );

      const arcsText =
        arcs.length > 0
          ? arcs
              .map(
                (a) =>
                  `  - ${a.title ?? "Untitled"} (${(a.participants ?? []).join(", ")})`
              )
              .join("\n")
          : "  (none)";

      const trendsText = [
        trends.emerging?.length
          ? `emerging: ${trends.emerging.join(", ")}`
          : null,
        trends.fading?.length
          ? `fading: ${trends.fading.join(", ")}`
          : null,
        trends.shifts ? `shifts: ${trends.shifts}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      const linksText =
        links.length > 0
          ? links
              .map((l) => `  - ${l.title ?? l.url ?? "link"}`)
              .join("\n")
          : "  (none)";

      return `[${date}]
Daily memo: ${r.daily_memo ?? "(none)"}
Arcs:
${arcsText}
Trends: ${trendsText || "(none)"}
Links:
${linksText}`;
    })
    .join("\n\n");

  return `The user was away from ${startDate} to ${endDate} (${nDays} day${nDays === 1 ? "" : "s"}).

Below are the daily briefings for that period. Identify cross-day through-lines, what escalated, what resolved, who drove conversations, what is still unresolved, and what is hot as of the last day (${lastDate}).

Informational only — no contribution suggestions.

${daysBlock}

Respond with JSON matching this exact schema:
{
  "catchup_memo": "<3-5 sentence headline narrative of the entire period>",
  "conversation_arcs": [
    {
      "title": "<arc title>",
      "participants": ["<name>"],
      "core_exchange": "<what was actually debated or built>",
      "why_it_matters": "<why this matters for the community>",
      "likely_next": "<what is likely to happen next>"
    }
  ],
  "themes": ["<recurring-topic-slug>"],
  "trends": {
    "emerging": ["<new topic gaining traction>"],
    "fading": ["<topic losing steam>"],
    "shifts": "<one sentence on the arc of this period>"
  },
  "links": [
    {
      "url": "<url>",
      "title": "<title>",
      "category": "<tool|repo|article|discussion>",
      "relevance": "<why it matters>"
    }
  ],
  "people_activity": [
    {
      "name": "<person name>",
      "role": "<what they drove during this period>"
    }
  ],
  "unresolved_threads": [
    {
      "title": "<thread title>",
      "status": "<where it stands as of ${endDate}>"
    }
  ],
  "hot_on_return": [
    {
      "title": "<arc or thread title>",
      "why_hot": "<why this is still active and worth re-engaging with first>"
    }
  ]
}

RULES:
- conversation_arcs: synthesize cross-day through-lines, not per-day summaries
- people_activity: who drove the most significant conversations; describe their specific contribution
- unresolved_threads: arcs with no clear resolution by ${endDate}
- hot_on_return: arcs active in the last 1-2 days of the window (${lastDate} and the day before if present)
- themes: short slug form e.g. "multi-agent-orchestration"
- Deduplicate links across days; keep only the most notable`;
}

function parseCatchupResult(raw: string): CatchupResult {
  try {
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)(?:```|$)/);
    if (fenceMatch) cleaned = fenceMatch[1];
    const data = JSON.parse(cleaned.trim()) as Partial<CatchupResult>;
    return { ...EMPTY_RESULT, ...data };
  } catch {
    return { ...EMPTY_RESULT };
  }
}

export async function runCatchupSynthesis(
  startDate: string,
  endDate: string
): Promise<CatchupResult> {
  const reports = getReportsForRange(startDate, endDate);
  const prompt = buildCatchupPrompt(reports, startDate, endDate);
  const response = await generateText({
    taskId: "dashboard.catchup",
    prompt,
    system:
      "You are an intelligence analyst producing a concise catchup briefing from daily reports. Informational only — no contribution suggestions. Always respond with valid JSON.",
  });
  return parseCatchupResult(response.text);
}
