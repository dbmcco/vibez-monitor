import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { searchMessages, getLatestBriefingMd } from "@/lib/db";
import fs from "fs";
import { getDossierPath, getSubjectName, getSubjectPossessive } from "@/lib/profile";

function buildSystemPrompt(subjectName: string, subjectPossessive: string): string {
  return `You are ${subjectPossessive} chat analyst for the Vibez WhatsApp ecosystem.
You answer questions about what's happening in the group chats, who said what,
trending topics, and help ${subjectName} understand conversations they may have missed.

Be concise, specific, and cite who said what when relevant. If you don't have
enough context to answer, say so clearly.

When the user asks follow-ups, use the conversation context provided.`;
}

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

function sanitizeHistory(input: unknown): ChatHistoryItem[] {
  if (!Array.isArray(input)) return [];
  const items: ChatHistoryItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (
      (role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.trim().length > 0
    ) {
      items.push({ role, content: content.trim().slice(0, 1200) });
    }
  }
  return items.slice(-10);
}

function loadDossierContext(subjectName: string, subjectPossessive: string): string {
  try {
    const dossierPath = getDossierPath();
    const raw = fs.readFileSync(dossierPath, "utf-8");
    const dossier = JSON.parse(raw);
    const identity = dossier.identity || {};
    const parts: string[] = [];
    if (identity.voice_summary)
      parts.push(`${subjectPossessive} profile: ${identity.voice_summary.slice(0, 300)}`);
    if (identity.expertise)
      parts.push(`Expertise: ${identity.expertise}`);
    if (dossier.summary)
      parts.push(`Current work: ${dossier.summary.slice(0, 400)}`);
    return parts.join("\n");
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  try {
    const { question, lookbackDays = 7, history } = await request.json();
    const subjectName = getSubjectName();
    const subjectPossessive = getSubjectPossessive(subjectName);
    const systemPrompt = buildSystemPrompt(subjectName, subjectPossessive);

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { error: "question is required" },
        { status: 400 }
      );
    }

    const chatHistory = sanitizeHistory(history);

    // Search for relevant messages
    const messages = await searchMessages({ query: question, lookbackDays });

    // Get latest briefing for high-level context
    const briefing = getLatestBriefingMd();

    // Load dossier context
    const dossierContext = loadDossierContext(subjectName, subjectPossessive);

    // Build message context
    let msgBlock = "";
    for (const m of messages) {
      const ts = new Date(m.timestamp).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      msgBlock += `[${ts}] [${m.room_name}] ${m.sender_name}: ${m.body.slice(0, 300)}\n`;
    }

    if (!msgBlock) {
      msgBlock = "(no matching messages found in the last " + lookbackDays + " days)";
    }

    let historyBlock = "";
    if (chatHistory.length > 0) {
      historyBlock =
        "Conversation context:\n" +
        chatHistory
          .map(
            (item) =>
              `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`
          )
          .join("\n\n") +
        "\n\n";
    }

    const prompt = `${dossierContext ? dossierContext + "\n\n" : ""}${
      briefing ? "Latest briefing:\n" + briefing.slice(0, 1500) + "\n\n" : ""
    }${historyBlock}Relevant messages (${messages.length} found):
${msgBlock}

Question: ${question}

Answer based on the messages above. Be specific — cite who said what, which group, and when.`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured" },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: process.env.CLASSIFIER_MODEL || "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    const answer =
      response.content[0].type === "text" ? response.content[0].text : "";

    return NextResponse.json({ answer, messageCount: messages.length });
  } catch (err) {
    console.error("Chat agent error:", err);
    return NextResponse.json(
      { error: "Failed to process question" },
      { status: 500 }
    );
  }
}
