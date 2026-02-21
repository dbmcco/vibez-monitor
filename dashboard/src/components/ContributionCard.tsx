import { RelevanceBadge } from "./RelevanceBadge";

interface Props {
  message: {
    id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
    contribution_hint: string | null;
  };
}

export function ContributionCard({ message }: Props) {
  const date = new Date(message.timestamp).toLocaleDateString();
  return (
    <div className="rounded-lg border border-slate-700/70 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <span className="vibe-chip rounded px-1.5 py-0.5 text-xs">
          {message.room_name}
        </span>
        <div className="flex items-center gap-2">
          <RelevanceBadge score={message.relevance_score} />
          <span className="text-xs text-slate-400">{date}</span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-300">
        <span className="font-medium text-slate-200">{message.sender_name}:</span>{" "}
        {message.body.slice(0, 200)}{message.body.length > 200 && "..."}
      </p>
      {message.contribution_hint && (
        <div className="mt-3 rounded border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200/95">
          {message.contribution_hint}
        </div>
      )}
    </div>
  );
}
