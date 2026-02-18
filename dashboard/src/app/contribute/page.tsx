"use client";

import { useEffect, useState } from "react";
import { ContributionCard } from "@/components/ContributionCard";

interface Message {
  id: string; room_name: string; sender_name: string; body: string;
  timestamp: number; relevance_score: number | null; contribution_hint: string | null;
}

export default function ContributePage() {
  const [contributions, setContributions] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/contributions")
      .then((r) => r.json())
      .then((data) => { setContributions(data.contributions); setLoading(false); });
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Contribution Opportunities</h1>
      {loading ? (<div className="text-zinc-500">Loading...</div>
      ) : contributions.length === 0 ? (<div className="text-zinc-500">No contribution opportunities yet.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {contributions.map((msg) => (<ContributionCard key={msg.id} message={msg} />))}
        </div>
      )}
    </div>
  );
}
