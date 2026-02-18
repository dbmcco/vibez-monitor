"use client";

import { useEffect, useState, useCallback } from "react";
import { MessageCard } from "@/components/MessageCard";

interface Message {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  contribution_flag: number | null;
  contribution_hint: string | null;
  alert_level: string | null;
}

export default function LiveFeed() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [filter, setFilter] = useState({ room: "", minRelevance: 0, contributionOnly: false });
  const [loading, setLoading] = useState(true);

  const fetchMessages = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.room) params.set("room", filter.room);
    if (filter.minRelevance) params.set("minRelevance", String(filter.minRelevance));
    if (filter.contributionOnly) params.set("contributionOnly", "true");

    const res = await fetch(`/api/messages?${params}`);
    const data = await res.json();
    setMessages(data.messages);
    setRooms(data.rooms);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 10_000);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Live Feed</h1>
        <select className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-300"
          value={filter.room} onChange={(e) => setFilter((f) => ({ ...f, room: e.target.value }))}>
          <option value="">All groups</option>
          {rooms.map((r) => (<option key={r} value={r}>{r}</option>))}
        </select>
        <select className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-300"
          value={filter.minRelevance} onChange={(e) => setFilter((f) => ({ ...f, minRelevance: parseInt(e.target.value) }))}>
          <option value={0}>All relevance</option>
          <option value={3}>3+</option>
          <option value={5}>5+</option>
          <option value={7}>7+</option>
          <option value={9}>9+</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-zinc-400">
          <input type="checkbox" checked={filter.contributionOnly}
            onChange={(e) => setFilter((f) => ({ ...f, contributionOnly: e.target.checked }))}
            className="rounded border-zinc-600" />
          Contributions only
        </label>
      </div>
      {loading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : messages.length === 0 ? (
        <div className="text-zinc-500">No messages yet. Start the sync service to begin capturing.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((msg) => (<MessageCard key={msg.id} message={msg} />))}
        </div>
      )}
    </div>
  );
}
