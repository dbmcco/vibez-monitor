// ABOUTME: Persistent chat rail component that follows the user across dashboard pages.
// ABOUTME: Supports per-page thread persistence, resize/collapse controls, and page-aware chat context.

"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  messageCount?: number;
}

interface PersistedRailState {
  width: number;
  collapsed: boolean;
  threads: Record<string, ChatMessage[]>;
}

const STORAGE_KEY = "vibez-chat-rail";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;
const MAX_WIDTH = 760;

const PAGE_LABELS: Record<string, string> = {
  "/": "Home",
  "/briefing": "Briefing",
  "/contribute": "Contribute",
  "/links": "Links",
  "/wisdom": "Wisdom",
  "/stats": "Stats",
  "/spaces": "Groups",
  "/settings": "Settings",
  "/chat": "Chat",
};

const STARTER_PROMPTS = [
  "What changed most in the group this week?",
  "Which topics are heating up right now?",
  "Who is driving the sharpest conversations lately?",
  "Summarize the strongest architecture discussions.",
];
const EMPTY_THREAD: ChatMessage[] = [];

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function pageLabelFor(pathname: string): string {
  if (PAGE_LABELS[pathname]) return PAGE_LABELS[pathname];
  const fallback = pathname.split("/").filter(Boolean).at(-1);
  return fallback ? fallback[0].toUpperCase() + fallback.slice(1) : "Home";
}

function loadState(): PersistedRailState {
  if (typeof window === "undefined") {
    return { width: DEFAULT_WIDTH, collapsed: false, threads: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { width: DEFAULT_WIDTH, collapsed: false, threads: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedRailState>;
    return {
      width:
        typeof parsed.width === "number" && Number.isFinite(parsed.width)
          ? clampWidth(parsed.width)
          : DEFAULT_WIDTH,
      collapsed: Boolean(parsed.collapsed),
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
    };
  } catch {
    return { width: DEFAULT_WIDTH, collapsed: false, threads: {} };
  }
}

function saveState(state: PersistedRailState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write failures; the rail still functions in-memory.
  }
}

export function ChatRail() {
  const pathname = usePathname() || "/";
  const [mounted, setMounted] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const resizerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(DEFAULT_WIDTH);

  const currentThread = threads[pathname] || EMPTY_THREAD;
  const pageLabel = pageLabelFor(pathname);
  const showRail = mounted && pathname !== "/chat";

  useEffect(() => {
    const state = loadState();
    setWidth(state.width);
    setCollapsed(state.collapsed);
    setThreads(state.threads);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    saveState({ width, collapsed, threads });
  }, [mounted, width, collapsed, threads]);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const nextWidth = showRail && !collapsed ? `${width}px` : "0px";
    document.documentElement.style.setProperty("--chat-rail-width", nextWidth);
    return () => {
      document.documentElement.style.setProperty("--chat-rail-width", "0px");
    };
  }, [showRail, collapsed, width]);

  useEffect(() => {
    if (!mounted || collapsed) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mounted, collapsed, currentThread, loading]);

  useEffect(() => {
    if (!showRail) return;
    const resizer = resizerRef.current;
    if (!resizer) return;

    let startX = 0;
    let startWidth = widthRef.current;

    function onMouseMove(event: MouseEvent) {
      const delta = startX - event.clientX;
      setWidth(clampWidth(startWidth + delta));
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    function onMouseDown(event: MouseEvent) {
      startX = event.clientX;
      startWidth = widthRef.current;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      event.preventDefault();
    }

    resizer.addEventListener("mousedown", onMouseDown);
    return () => {
      resizer.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [showRail]);

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || loading) return;

    const currentPath = pathname;
    const currentPageLabel = pageLabelFor(currentPath);
    const userMessage: ChatMessage = { role: "user", content: text };
    const nextThread = [...(threads[currentPath] || []), userMessage];

    setThreads((prev) => ({ ...prev, [currentPath]: nextThread }));
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          history: nextThread.slice(-10).map(({ role, content }) => ({ role, content })),
          context: { page: currentPath, pageLabel: currentPageLabel },
        }),
      });
      const data = await response.json();
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content:
          typeof data.answer === "string" && data.answer.trim().length > 0
            ? data.answer
            : typeof data.error === "string"
              ? data.error
              : "No response from the chat agent.",
        messageCount:
          typeof data.messageCount === "number" && Number.isFinite(data.messageCount)
            ? data.messageCount
            : undefined,
      };
      setThreads((prev) => ({
        ...prev,
        [currentPath]: [...(prev[currentPath] || nextThread), assistantMessage],
      }));
    } catch {
      setThreads((prev) => ({
        ...prev,
        [currentPath]: [
          ...(prev[currentPath] || nextThread),
          { role: "assistant", content: "Failed to reach the chat agent." },
        ],
      }));
    } finally {
      setLoading(false);
    }
  }

  if (!mounted || !showRail) {
    return null;
  }

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="chat-rail-fab fixed bottom-5 right-5 z-50 hidden h-12 w-12 items-center justify-center rounded-full border border-cyan-400/40 bg-slate-900/95 text-cyan-300 shadow-lg transition hover:bg-slate-800 hover:shadow-cyan-400/20 lg:flex"
        title="Open chat rail"
        aria-label="Open chat rail"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    );
  }

  return (
    <aside
      className="chat-rail hidden lg:flex"
      style={{ width: `${width}px`, minWidth: `${MIN_WIDTH}px`, maxWidth: `${MAX_WIDTH}px` }}
    >
      <div
        ref={resizerRef}
        className="chat-rail-resizer absolute left-0 top-0 h-full w-1.5 cursor-col-resize"
        aria-hidden="true"
      />

      <div className="border-b border-slate-800/80 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="vibe-title text-sm text-slate-100">Chat</h2>
            <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Context: {pageLabel}
            </p>
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="text-[11px] text-slate-500 transition hover:text-slate-300"
          >
            Hide
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {currentThread.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-slate-500">
              Ask anything about what the group has discussed. Threads persist per page, so the rail keeps
              your context as you move around the dashboard.
            </p>
            <div className="space-y-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => void sendMessage(prompt)}
                  className="block w-full rounded-lg border border-slate-700/60 bg-slate-950/40 px-3 py-2 text-left text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {currentThread.map((message, index) => (
          <div
            key={`${message.role}-${index}-${message.content.slice(0, 32)}`}
            className={message.role === "user" ? "pl-6" : ""}
          >
            <div
              className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${
                message.role === "user"
                  ? "border border-cyan-400/40 bg-cyan-900/30 text-cyan-100"
                  : "border border-slate-700/70 bg-slate-950/55 text-slate-200"
              }`}
            >
              {message.role === "user" ? (
                <p className="whitespace-pre-wrap">{message.content}</p>
              ) : (
                <div className="space-y-2 break-words [&_a]:text-cyan-300 [&_a]:underline [&_code]:rounded [&_code]:bg-slate-800/80 [&_code]:px-1.5 [&_li]:ml-4 [&_li]:list-disc [&_ol]:ml-4 [&_ol]:list-decimal [&_p]:m-0 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-950/80 [&_pre]:p-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                </div>
              )}
              {message.messageCount !== undefined ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  Based on {message.messageCount} messages
                </p>
              ) : null}
            </div>
          </div>
        ))}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="vibe-spinner inline-block h-3 w-3 rounded-full border-2 border-slate-600 border-t-cyan-400" />
            Thinking...
          </div>
        ) : null}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-slate-800/80 px-4 py-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(input);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={`Ask about ${pageLabel.toLowerCase()}...`}
            className="vibe-input flex-1 rounded-lg px-3 py-2 text-xs"
            disabled={loading}
            aria-label={`Ask about ${pageLabel}`}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg border border-cyan-400/35 bg-cyan-900/35 px-3 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-800/45 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Send
          </button>
        </form>
      </div>
    </aside>
  );
}
