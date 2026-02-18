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
    <div className="rounded-lg border border-emerald-900 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{message.room_name}</span>
        <div className="flex items-center gap-2">
          <RelevanceBadge score={message.relevance_score} />
          <span className="text-xs text-zinc-500">{date}</span>
        </div>
      </div>
      <p className="mt-2 text-sm text-zinc-300">
        <span className="font-medium">{message.sender_name}:</span>{" "}
        {message.body.slice(0, 200)}{message.body.length > 200 && "..."}
      </p>
      {message.contribution_hint && (
        <div className="mt-3 rounded bg-emerald-950/50 border border-emerald-800 px-3 py-2 text-sm text-emerald-300">
          {message.contribution_hint}
        </div>
      )}
    </div>
  );
}
