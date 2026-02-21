import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getTopicDrilldown, TopicDrilldown } from "@/lib/db";

const TOPIC_SYSTEM_PROMPT = `You are Braydon's strategic topic analyst for the Vibez community.
Given topic analytics and message excerpts, provide:
1) a concise summary of what matters now,
2) practical guidance for how Braydon should engage,
3) watch-outs or blind spots,
4) high-leverage next questions.

Be specific, concrete, and action-oriented.`;

interface TopicInsights {
  summary: string;
  guidance: string[];
  watchouts: string[];
  next_questions: string[];
}

function parseDaysParam(daysParam: string | null): number | null {
  if (daysParam && daysParam.toLowerCase() === "all") return null;
  const parsed = Number.parseInt(daysParam || "90", 10);
  return Number.isFinite(parsed) ? parsed : 90;
}

function parseInsights(raw: string): TopicInsights | null {
  const tryParse = (candidate: string): TopicInsights | null => {
    try {
      const data = JSON.parse(candidate) as TopicInsights;
      if (!data || typeof data !== "object") return null;
      if (typeof data.summary !== "string") return null;
      return {
        summary: data.summary,
        guidance: Array.isArray(data.guidance) ? data.guidance.map(String) : [],
        watchouts: Array.isArray(data.watchouts) ? data.watchouts.map(String) : [],
        next_questions: Array.isArray(data.next_questions)
          ? data.next_questions.map(String)
          : [],
      };
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = tryParse(fencedMatch[1].trim());
    if (fenced) return fenced;
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const extracted = tryParse(raw.slice(firstBrace, lastBrace + 1));
    if (extracted) return extracted;
  }

  const fallback = raw.trim();
  if (!fallback) return null;
  return {
    summary: fallback,
    guidance: [],
    watchouts: [],
    next_questions: [],
  };
}

async function generateTopicInsights(drilldown: TopicDrilldown): Promise<TopicInsights | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const topUsers = drilldown.top_users
    .slice(0, 8)
    .map((user) => `${user.name}: ${user.messages}`)
    .join(", ");
  const topChannels = drilldown.top_channels
    .slice(0, 8)
    .map((channel) => `${channel.name}: ${channel.messages}`)
    .join(", ");
  const related = drilldown.related_topics
    .slice(0, 10)
    .map((edge) => `${edge.topic_b} (co=${edge.co_messages}, trend=${edge.trend})`)
    .join(", ");
  const excerpts = drilldown.recent_messages
    .slice(0, 20)
    .map(
      (message) =>
        `[${message.date}] [${message.room_name}] ${message.sender_name}: ${message.body.slice(0, 260)}`,
    )
    .join("\n");

  const prompt = `Topic: ${drilldown.topic}
Window days: ${drilldown.window_days}
Stats:
- first_seen: ${drilldown.summary.first_seen}
- last_seen: ${drilldown.summary.last_seen}
- message_count: ${drilldown.summary.message_count}
- active_days: ${drilldown.summary.active_days}
- recurrence_ratio: ${drilldown.summary.recurrence_ratio}
- trend: ${drilldown.summary.trend}
- last_7d vs prev_7d: ${drilldown.summary.last_7d} vs ${drilldown.summary.prev_7d}

Top users: ${topUsers || "(none)"}
Top channels: ${topChannels || "(none)"}
Related topics: ${related || "(none)"}

Recent excerpts:
${excerpts || "(none)"}

Return valid JSON only with keys:
{
  "summary": string,
  "guidance": string[],
  "watchouts": string[],
  "next_questions": string[]
}`;

  const response = await client.messages.create({
    model: process.env.CLASSIFIER_MODEL || "claude-sonnet-4-6",
    max_tokens: 900,
    system: TOPIC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  return parseInsights(text);
}

export async function GET(request: NextRequest) {
  try {
    const topic = (request.nextUrl.searchParams.get("topic") || "").trim();
    const days = parseDaysParam(request.nextUrl.searchParams.get("days"));
    if (!topic) {
      return NextResponse.json({ drilldown: null, insights: null }, { status: 400 });
    }

    const drilldown = getTopicDrilldown(topic, days);
    if (!drilldown) {
      return NextResponse.json({ drilldown: null, insights: null });
    }

    const insights = await generateTopicInsights(drilldown);
    return NextResponse.json({ drilldown, insights });
  } catch {
    return NextResponse.json({ drilldown: null, insights: null }, { status: 500 });
  }
}
