import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { getContributionDashboard } from "@/lib/db";

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return fallback;
}

interface SmartContributionEval {
  id: string;
  business_learning_value: number;
  relationship_upside: number;
  promotion_risk: number;
  novelty_signal: number;
  execution_clarity: number;
  community_fit: number;
  smart_priority_delta: number;
  recommended_action: string;
  rationale: string;
}

interface SmartContributionPayload {
  summary: string;
  evaluations: SmartContributionEval[];
}

type ContributionDashboard = ReturnType<typeof getContributionDashboard>;
type BaseOpportunity = ContributionDashboard["opportunities"][number];
type EnhancedOpportunity = BaseOpportunity & {
  priority_score_model?: number;
  model_intel?: SmartContributionEval;
};

const SMART_SYSTEM_PROMPT = `You are Braydon's strategic contribution intelligence model for a highly technical AI/OSS/business-learning community.

Primary objective:
- Rank opportunities by true contribution value and learning leverage, not by simplistic policy checks.

Community context:
- Members are deeply technical and experimental.
- They value concrete business insight and relationship-building.
- Overt selling is low-value in this context; value-first teaching/collaboration is high-value.

For each opportunity, infer:
- business_learning_value: how much practical business/strategy learning this could unlock for the group.
- relationship_upside: likelihood this strengthens meaningful long-term relationships.
- promotion_risk: likelihood response would be perceived as self-promotion/pitch.
- novelty_signal: whether it opens new ideas versus repeating known points.
- execution_clarity: how clear and actionable the next contribution is.
- community_fit: alignment with technical OSS/value-first norms.
- smart_priority_delta: adjustment (-15..15) to baseline priority based on nuanced judgment.
- recommended_action: specific contribution move (e.g., ask_question, share_framework, draft_example, connect_people, private_followup).
- rationale: one concise sentence with the key reason.

Return strict JSON only.`;

const SMART_CACHE_TTL_MS = 5 * 60 * 1000;
const SMART_CACHE = new Map<string, { expiresAt: number; payload: SmartContributionPayload }>();

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseSmartPayload(raw: string): SmartContributionPayload | null {
  const tryParse = (candidate: string): SmartContributionPayload | null => {
    try {
      const data = JSON.parse(candidate) as SmartContributionPayload;
      if (!data || typeof data !== "object" || !Array.isArray(data.evaluations)) return null;
      const evaluations = data.evaluations
        .map((item) => {
          if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
          return {
            id: item.id,
            business_learning_value: clamp(Number(item.business_learning_value), 0, 10),
            relationship_upside: clamp(Number(item.relationship_upside), 0, 10),
            promotion_risk: clamp(Number(item.promotion_risk), 0, 10),
            novelty_signal: clamp(Number(item.novelty_signal), 0, 10),
            execution_clarity: clamp(Number(item.execution_clarity), 0, 10),
            community_fit: clamp(Number(item.community_fit), 0, 10),
            smart_priority_delta: clamp(Number(item.smart_priority_delta), -15, 15),
            recommended_action:
              typeof item.recommended_action === "string" ? item.recommended_action : "",
            rationale: typeof item.rationale === "string" ? item.rationale : "",
          } as SmartContributionEval;
        })
        .filter((item): item is SmartContributionEval => item !== null);
      return {
        summary: typeof data.summary === "string" ? data.summary : "",
        evaluations,
      };
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    const parsed = tryParse(fenced);
    if (parsed) return parsed;
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = tryParse(raw.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }
  return null;
}

function smartCacheKey(
  model: string,
  days: number,
  limit: number,
  opportunities: Array<{ id: string; timestamp: number; priority_score: number }>,
): string {
  const signature = opportunities
    .slice(0, 60)
    .map((item) => `${item.id}:${item.timestamp}:${item.priority_score}`)
    .join("|");
  const digest = createHash("sha256").update(signature).digest("hex");
  return `${model}:${days}:${limit}:${digest}`;
}

async function generateSmartIntel(
  model: string,
  days: number,
  limit: number,
  opportunities: Array<{
    id: string;
    timestamp: number;
    room_name: string;
    sender_name: string;
    body: string;
    contribution_hint?: string | null;
    topics?: string[];
    contribution_themes?: string[];
    need_type?: string;
    hours_old?: number;
    priority_score?: number;
  }>,
): Promise<SmartContributionPayload | null> {
  if (opportunities.length === 0) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const key = smartCacheKey(
    model,
    days,
    limit,
    opportunities.map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      priority_score: Number(item.priority_score || 0),
    })),
  );
  const cached = SMART_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const compactRows = opportunities.slice(0, 60).map((item) => {
    const topics = Array.isArray(item.topics) ? item.topics.slice(0, 4).join(", ") : "";
    const themes = Array.isArray(item.contribution_themes)
      ? item.contribution_themes.slice(0, 3).join(", ")
      : "";
    const hint = (item.contribution_hint || "").slice(0, 220);
    const text = (item.body || "").replace(/\s+/g, " ").trim().slice(0, 320);
    const sender = String(item.sender_name || "Unknown").replace(/\n/g, " ");
    const room = String(item.room_name || "Unknown").replace(/\n/g, " ");
    const needType = String(item.need_type || "none");
    const hoursOld = Number(item.hours_old || 0).toFixed(1);
    const baseline = Number(item.priority_score || 0).toFixed(1);
    return [
      `id=${item.id}`,
      `room=${room}`,
      `sender=${sender}`,
      `need=${needType}`,
      `hours_old=${hoursOld}`,
      `baseline=${baseline}`,
      `topics=${topics || "-"}`,
      `themes=${themes || "-"}`,
      `hint=${hint || "-"}`,
      `text=${text || "-"}`,
    ].join(" | ");
  });

  const prompt = `Analyze contribution opportunities for nuanced community value.

Window: ${days} days
Candidate count: ${compactRows.length}

Opportunities:
${compactRows.map((row) => `- ${row}`).join("\n")}

Return JSON exactly:
{
  "summary": "<2-4 sentence synthesis of where contribution leverage is highest right now>",
  "evaluations": [
    {
      "id": "<opportunity id>",
      "business_learning_value": <0-10>,
      "relationship_upside": <0-10>,
      "promotion_risk": <0-10>,
      "novelty_signal": <0-10>,
      "execution_clarity": <0-10>,
      "community_fit": <0-10>,
      "smart_priority_delta": <-15..15>,
      "recommended_action": "<one concrete action>",
      "rationale": "<one concise sentence>"
    }
  ]
}`;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 3200,
    system: SMART_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const payload = parseSmartPayload(text);
  if (!payload) return null;

  SMART_CACHE.set(key, { expiresAt: Date.now() + SMART_CACHE_TTL_MS, payload });
  return payload;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function mergeSmartIntel(
  dashboard: ContributionDashboard,
  payload: SmartContributionPayload | null,
) {
  if (!payload) {
    return {
      ...dashboard,
      smart_model: {
        enabled: false,
        summary: "",
        coverage: 0,
        model: "",
      },
    };
  }

  const evalMap = new Map(payload.evaluations.map((item) => [item.id, item]));
  const opportunities = dashboard.opportunities
    .map((item) => {
      const base: EnhancedOpportunity = { ...item };
      const intel = evalMap.get(item.id);
      if (!intel) return base;

      const modelComposite =
        intel.business_learning_value * 0.24 +
        intel.relationship_upside * 0.16 +
        intel.novelty_signal * 0.14 +
        intel.execution_clarity * 0.12 +
        intel.community_fit * 0.18 -
        intel.promotion_risk * 0.16;

      const smartPriority = clamp(
        item.priority_score + modelComposite * 1.6 + intel.smart_priority_delta * 1.8,
        0,
        100,
      );

      return {
        ...base,
        priority_score_model: Number(smartPriority.toFixed(1)),
        model_intel: intel,
      };
    })
    .sort((a, b) => {
      const bScore = b.priority_score_model ?? b.priority_score;
      const aScore = a.priority_score_model ?? a.priority_score;
      if (bScore !== aScore) return bScore - aScore;
      return 0;
    });

  const oppById = new Map(opportunities.map((item) => [item.id, item]));
  const sections = dashboard.sections.map((section) => ({
    ...section,
    items: section.items
      .map((item) => oppById.get(item.id) || item)
      .sort((a, b) => {
        const bScore =
          (b as EnhancedOpportunity).priority_score_model ??
          (b as EnhancedOpportunity).priority_score;
        const aScore =
          (a as EnhancedOpportunity).priority_score_model ??
          (a as EnhancedOpportunity).priority_score;
        if (bScore !== aScore) return bScore - aScore;
        return 0;
      }),
  }));

  return {
    ...dashboard,
    opportunities,
    sections,
    smart_model: {
      enabled: true,
      summary: payload.summary,
      coverage: Number(
        (
          (payload.evaluations.length / Math.max(1, dashboard.opportunities.length)) *
          100
        ).toFixed(1),
      ),
      model: process.env.CLASSIFIER_MODEL || "claude-sonnet-4-6",
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const days = parsePositiveInt(request.nextUrl.searchParams.get("days"), 45);
    const limit = parsePositiveInt(request.nextUrl.searchParams.get("limit"), 600);
    const smart = parseBoolean(request.nextUrl.searchParams.get("smart"), true);
    const dashboard = getContributionDashboard({ lookbackDays: days, limit });
    const modelName = process.env.CLASSIFIER_MODEL || "claude-sonnet-4-6";
    let smartPayload: SmartContributionPayload | null = null;
    if (smart) {
      try {
        smartPayload = await withTimeout(
          generateSmartIntel(modelName, days, limit, dashboard.opportunities),
          12000,
        );
      } catch (error) {
        console.warn("Smart contribution intel unavailable, serving baseline ranking:", error);
        smartPayload = null;
      }
    }
    const merged = smart ? mergeSmartIntel(dashboard, smartPayload) : dashboard;
    return NextResponse.json({
      ...merged,
      contributions: merged.opportunities,
    });
  } catch (error) {
    console.error("GET /api/contributions failed:", error);
    return NextResponse.json({
      generated_at: new Date().toISOString(),
      lookback_days: 45,
      totals: { messages: 0, opportunities: 0, act_now: 0, high_leverage: 0, aging_risk: 0, blocked: 0 },
      axis_summary: [],
      need_summary: [],
      recurring_themes: [],
      opportunities: [],
      sections: [],
      smart_model: { enabled: false, summary: "", coverage: 0, model: "" },
      contributions: [],
    });
  }
}
