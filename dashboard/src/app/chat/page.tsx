"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  messageCount?: number;
}

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

const STARTER_PROMPTS = [
  "What changed most in AGI this week?",
  "Which topics are heating up and who is driving them?",
  "What are the top 3 actionable follow-ups for me today?",
  "Show the strongest quotes and references from the last 48 hours.",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendQuestion(question: string) {
    if (!question || loading) return;

    const history: ChatHistoryItem[] = messages
      .slice(-10)
      .map(({ role, content }) => ({ role, content }));

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.error}` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.answer,
            messageCount: data.messageCount,
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Failed to reach the chat agent." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await sendQuestion(input.trim());
  }

  async function askPrompt(prompt: string) {
    await sendQuestion(prompt.trim());
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
      <header className="fade-up space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Chat Agent
        </h1>
        <p className="vibe-subtitle">
          Query the collected conversation stream and get focused synthesis.
        </p>
      </header>

      <div className="vibe-panel flex-1 overflow-y-auto rounded-xl p-4 sm:p-5">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-slate-400">
              <p className="vibe-title text-xl text-slate-200">
                Ask anything about the group chats
              </p>
              <div className="mt-4 grid gap-2 text-left text-sm text-slate-500 sm:grid-cols-2">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => askPrompt(prompt)}
                    className="rounded-md border border-slate-700/70 bg-slate-900/45 px-3 py-2 text-left text-sm text-slate-300 hover:border-cyan-300/60 hover:text-slate-100"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`mb-4 ${msg.role === "user" ? "text-right" : "text-left"}`}
          >
            <div
              className={`inline-block max-w-[86%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "border border-cyan-400/40 bg-cyan-900/30 text-cyan-100"
                  : "border border-slate-700/80 bg-slate-900/70 text-slate-200"
              }`}
            >
              {msg.role === "user" ? (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <div className="space-y-2 break-words [&_a]:text-cyan-300 [&_a]:underline [&_code]:rounded [&_code]:bg-slate-800/80 [&_code]:px-1.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol]:ml-4 [&_ol]:list-decimal [&_p]:m-0 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-950/80 [&_pre]:p-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              )}
              {msg.messageCount !== undefined && (
                <p className="mt-2 text-xs text-slate-400">
                  Based on {msg.messageCount} messages
                </p>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="mb-4 text-left">
            <div className="inline-block rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2 text-sm text-slate-300">
              Searching chats...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the group chats..."
          className="vibe-input flex-1 rounded-lg px-4 py-2.5 text-sm"
          disabled={loading}
          suppressHydrationWarning
          aria-label="Ask the chat agent a question"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="vibe-button rounded-lg px-4 py-2.5 text-sm tracking-wide disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Asking..." : "Ask"}
        </button>
      </form>
    </div>
  );
}
