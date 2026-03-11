// ABOUTME: Model-enhanced analysis API for wisdom cards.
// ABOUTME: Rewrites a wisdom takeaway into actionable guidance with value, applicability, execution, and caveats.

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import {
  enforceApiUsageGuard,
  getClientIp,
  recordApiUsageError,
  recordApiUsageSuccess,
} from "@/lib/api-usage";

const ROUTE_KEY = "/api/wisdom/enhance";
const SYSTEM_PROMPT =
  "Return strict JSON only in the form {\"analysis\":\"...\"}. Do not wrap the JSON in markdown fences.";

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
  return `You are writing the "Model Enhanced Analysis" for a technical knowledge dashboard.

Topic: ${topicName}
Knowledge type: ${knowledgeType || "unknown"}
Primary takeaway: ${title}
Existing explanation: ${summary || "(none)"}
Topic context: ${topicSummary || "(none)"}

Your job is to turn the takeaway into advice a builder can actually use.

Reason silently before writing:
1. What part of this advice is genuinely valuable or differentiated?
2. When should a user apply it, and when would it be the wrong move?
3. What concrete action would let a user benefit from it?
4. What tradeoff, limit, or failure mode matters most?

Requirements:
- Return one plain-text string under "analysis" with exactly 4 labeled lines:
  Value: ...
  Use it when: ...
  How to apply it: ...
  Watch out: ...
- Each line should be a single sentence.
- Total length should stay under 170 words.
- Focus on applied technical judgment, not summary filler.
- Do not repeat the title verbatim unless needed for clarity.
- Do not mention chats, speakers, the community, sources, or that this came from a model.
- If the claim is too broad, narrow it to the part that is actually useful.

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
      process.env.SYNTHESIS_MODEL ||
      process.env.CLASSIFIER_MODEL ||
      "claude-sonnet-4-6";
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
          max_tokens: 320,
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
