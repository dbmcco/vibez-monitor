import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { searchMessages, getLatestBriefingMd, searchLinksFts, type LinkRow } from "@/lib/db";
import fs from "fs";
import { getDossierPath, getSubjectName, getSubjectPossessive } from "@/lib/profile";
import {
  enforceApiUsageGuard,
  getClientIp,
  recordApiUsageError,
  recordApiUsageSuccess,
} from "@/lib/api-usage";

function buildSystemPrompt(subjectName: string, subjectPossessive: string): string {
  return `You are ${subjectPossessive} chat analyst for the Vibez WhatsApp ecosystem.
You answer questions about what's happening in the group chats, who said what,
trending topics, and help ${subjectName} understand conversations they may have missed.

Be concise, specific, and cite who said what when relevant. If you don't have
enough context to answer, say so clearly.

When the user is looking for a link, URL, repo, post, or document, include the direct URL in plain text.
Do not hide URLs behind markdown link text if the user is trying to find the link itself.

When the user asks follow-ups, use the conversation context provided.`;
}

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

interface ChatContextPayload {
  page?: string;
  pageLabel?: string;
}

const LINK_QUERY_PATTERN =
  /\b(link|url|website|site|repo|repository|github|article|post|docs?|documentation|readme|substack|video|youtube)\b/i;

function isLinkFocusedQuestion(question: string, context?: ChatContextPayload): boolean {
  return LINK_QUERY_PATTERN.test(question) || context?.page === "/links";
}

function buildLinkBlock(links: LinkRow[]): string {
  if (links.length === 0) return "";
  const lines = links.map((link, index) => {
    const title = (link.title || link.url).trim();
    const sharedBy = link.shared_by?.trim() || "unknown";
    const sourceGroup = link.source_group?.trim() || "unknown group";
    const relevance = (link.relevance || "").trim().replace(/\s+/g, " ").slice(0, 220);
    return [
      `${index + 1}. ${title}`,
      `   URL: ${link.url}`,
      `   Shared by: ${sharedBy}`,
      `   Group: ${sourceGroup}`,
      relevance ? `   Why it matters: ${relevance}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `Candidate links from the dedicated links index:\n${lines.join("\n")}\n\n`;
}

function makeUrlsVisible(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
    const cleanLabel = label.trim();
    const cleanUrl = url.trim();
    if (!cleanLabel || cleanLabel === cleanUrl) return cleanUrl;
    return `${cleanLabel} - ${cleanUrl}`;
  });
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
    const routeKey = "/api/chat";
    const { question, lookbackDays = 7, history, context } = await request.json();
    const subjectName = getSubjectName();
    const subjectPossessive = getSubjectPossessive(subjectName);
    const systemPrompt = buildSystemPrompt(subjectName, subjectPossessive);

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { error: "question is required" },
        { status: 400 }
      );
    }

    const chatContext = (context || undefined) as ChatContextPayload | undefined;
    const chatHistory = sanitizeHistory(history);
    const wantsLinks = isLinkFocusedQuestion(question, chatContext);
    const contextPrefix = chatContext?.pageLabel
      ? `The user is currently viewing the "${chatContext.pageLabel}" page of the vibez dashboard${
          chatContext.page ? ` (${chatContext.page})` : ""
        }. Use that page context when it helps prioritize the answer.\n\n`
      : "";
    const linkCandidates = wantsLinks ? searchLinksFts(question, { limit: 8, sort: "value" }) : [];
    const linkBlock = wantsLinks ? buildLinkBlock(linkCandidates) : "";

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

    const prompt = `${contextPrefix}${dossierContext ? dossierContext + "\n\n" : ""}${
      briefing ? "Latest briefing:\n" + briefing.slice(0, 1500) + "\n\n" : ""
    }${historyBlock}${linkBlock}Relevant messages (${messages.length} found):
${msgBlock}

Question: ${question}

Answer based on the messages above. Be specific — cite who said what, which group, and when.${
      wantsLinks
        ? "\n\nIf you know the link, include the full direct URL in plain text. Prefer bullet points in the form `Title - https://...`."
        : ""
    }`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured" },
        { status: 500 }
      );
    }

    const model = process.env.CLASSIFIER_MODEL || "claude-sonnet-4-6";
    const clientIp = getClientIp(request);
    const guard = enforceApiUsageGuard({ route: routeKey, model, clientIp });
    if (!guard.allowed) {
      return NextResponse.json(
        {
          error: guard.message || "AI request blocked by usage guard.",
          lockout: {
            reason: guard.reason,
            state: guard.state,
          },
        },
        { status: guard.statusCode },
      );
    }

    const client = new Anthropic({ apiKey });
    const response = await (async () => {
      try {
        const result = await client.messages.create({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        });
        recordApiUsageSuccess({ route: routeKey, model, clientIp, usage: result.usage });
        return result;
      } catch (error) {
        recordApiUsageError({
          route: routeKey,
          model,
          clientIp,
          reason: error instanceof Error ? error.message : "anthropic_request_failed",
        });
        throw error;
      }
    })();

    const answer =
      response.content[0].type === "text" ? response.content[0].text : "";
    const visibleAnswer = wantsLinks ? makeUrlsVisible(answer) : answer;

    return NextResponse.json({ answer: visibleAnswer, messageCount: messages.length });
  } catch (err) {
    console.error("Chat agent error:", err);
    return NextResponse.json(
      { error: "Failed to process question" },
      { status: 500 }
    );
  }
}
