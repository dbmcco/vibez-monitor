// ABOUTME: API route for wisdom knowledge graph queries.
// ABOUTME: Supports topic listing, type grouping, drill-down, recommendations, and stats.

import { NextRequest, NextResponse } from "next/server";
import {
  getWisdomItemsByTopic,
  getWisdomItemsByType,
  getWisdomRecommendations,
  getWisdomStats,
  getWisdomTopics,
} from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    if (params.get("stats") === "1") {
      return NextResponse.json(getWisdomStats());
    }

    if (params.has("type")) {
      const knowledgeType = params.get("type")?.trim() || undefined;
      return NextResponse.json({ items: getWisdomItemsByType(knowledgeType) });
    }

    if (params.has("topic")) {
      const topicSlug = params.get("topic")?.trim();
      if (!topicSlug) {
        return NextResponse.json({ error: "topic is required" }, { status: 400 });
      }
      const topic = getWisdomItemsByTopic(topicSlug);
      if (!topic) {
        return NextResponse.json({ error: "Topic not found" }, { status: 404 });
      }
      return NextResponse.json(topic);
    }

    if (params.has("recommendations")) {
      const topicId = Number.parseInt(params.get("recommendations") || "", 10);
      if (!Number.isFinite(topicId)) {
        return NextResponse.json({ recommendations: [], error: "Invalid topic id" }, { status: 400 });
      }
      return NextResponse.json({ recommendations: getWisdomRecommendations(topicId) });
    }

    return NextResponse.json({ topics: getWisdomTopics() });
  } catch (err) {
    console.error("Wisdom API error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
