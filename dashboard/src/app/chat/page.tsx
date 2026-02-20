"use client";

import { useState, useRef, useEffect } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  messageCount?: number;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
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

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <h1 className="mb-4 text-xl font-semibold">Chat Agent</h1>

      <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-zinc-500">
              <p className="text-lg">Ask anything about the group chats</p>
              <div className="mt-4 flex flex-col gap-2 text-sm text-zinc-600">
                <p>&quot;What was the main discussion in AGI House today?&quot;</p>
                <p>&quot;Who mentioned multi-agent systems this week?&quot;</p>
                <p>&quot;What links were shared about context windows?&quot;</p>
                <p>&quot;Where could I contribute based on my expertise?&quot;</p>
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
              className={`inline-block max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-blue-900 text-blue-100"
                  : "bg-zinc-800 text-zinc-200"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.messageCount !== undefined && (
                <p className="mt-1 text-xs text-zinc-500">
                  Based on {msg.messageCount} messages
                </p>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="mb-4 text-left">
            <div className="inline-block rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-400">
              Searching chats...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the group chats..."
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-600 focus:outline-none"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
