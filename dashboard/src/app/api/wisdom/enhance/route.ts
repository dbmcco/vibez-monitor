// ABOUTME: Model-enhanced analysis API for wisdom cards.
// ABOUTME: Expands a wisdom takeaway with applicability and tradeoff context.

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import {
  enforceApiUsageGuard,
  getClientIp,
  recordApiUsageError,
  recordApiUsageSuccess,
} from "@/lib/api-usage";

const ROUTE_KEY = "/api/wisdom/enhance";
const SYSTEM_PROMPT = "Return strict JSON only in the form {\"analysis\":\"...\"}. No markdown.";

interface EnhancePayload {
  topicName?: unknown;
  topicSummary?: unknown;
  knowledgeType?: unknown;
  title?: unknown;
  summary?: unknown;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAnalysis(raw: string): string {
  const candidates: string[] = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { analysis?: unknown };
      if (typeof parsed.analysis === "string" && parsed.analysis.trim()) {
        return parsed.analysis.trim();
      }
    } catch {
      // Fall through to raw-text cleanup.
    }
  }

  return raw.trim().replace(/^analysis:\s*/i, "");
}

function buildPrompt({
  topicName,
  topicSummary,
  knowledgeType,
  title,
  summary,
}: {
  topicName: string;
  topicSummary: string;
  knowledgeType: string;
  title: string;
  summary: string;
}): string {
  return `You are enhancing a card in a knowledge dashboard.

Topic: ${topicName}
Knowledge type: ${knowledgeType || "unknown"}
Primary takeaway: ${title}
Existing explanation: ${summary || "(none)"}
Topic context: ${topicSummary || "(none)"}

Write a model-enhanced analysis that adds value beyond the existing text.

Requirements:
- 2 or 3 concise sentences, max 90 words
- explain when this guidance applies, why it matters, and the sharpest tradeoff
- do not repeat the title verbatim
- do not mention chats, speakers, the community, or that this came from a model
- be concrete, not motivational

Return JSON only.`;
}

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as EnhancePayload;
    const topicName = cleanString(payload.topicName);
    const topicSummary = cleanString(payload.topicSummary);
    const knowledgeType = cleanString(payload.knowledgeType);
    const title = cleanString(payload.title);
    const summary = cleanString(payload.summary);

    if (!topicName || !title) {
      return NextResponse.json({ error: "topicName and title are required" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const model =
      process.env.WISDOM_ENHANCE_MODEL ||
      process.env.CLASSIFIER_MODEL ||
      "claude-haiku-4-5-20251001";
    const clientIp = getClientIp(request);
    const guard = enforceApiUsageGuard({ route: ROUTE_KEY, model, clientIp });
    if (!guard.allowed) {
      return NextResponse.json(
        { error: "Model enhanced analysis is temporarily unavailable." },
        { status: guard.statusCode },
      );
    }

    const client = new Anthropic({ apiKey });
    const response = await (async () => {
      try {
        const result = await client.messages.create({
          model,
          max_tokens: 220,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildPrompt({ topicName, topicSummary, knowledgeType, title, summary }),
            },
          ],
        });
        recordApiUsageSuccess({ route: ROUTE_KEY, model, clientIp, usage: result.usage });
        return result;
      } catch (error) {
        recordApiUsageError({
          route: ROUTE_KEY,
          model,
          clientIp,
          reason: error instanceof Error ? error.message : "wisdom_enhance_failed",
        });
        throw error;
      }
    })();

    const raw = response.content
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("\n")
      .trim();
    const analysis = parseAnalysis(raw);

    if (!analysis) {
      return NextResponse.json({ error: "No enhanced analysis returned." }, { status: 502 });
    }

    return NextResponse.json({ analysis });
  } catch (error) {
    console.error("Wisdom enhance API error:", error);
    return NextResponse.json({ error: "Failed to generate enhanced analysis." }, { status: 500 });
  }
}
