import { RelevanceBadge } from "./RelevanceBadge";

interface Props {
  message: {
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
  };
}

export function MessageCard({ message }: Props) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = new Date(message.timestamp).toLocaleDateString();
  const topics: string[] = message.topics ? JSON.parse(message.topics) : [];
  const borderColor =
    message.alert_level === "hot"
      ? "border-l-red-500"
      : message.alert_level === "digest"
        ? "border-l-amber-500"
        : "border-l-zinc-700";

  return (
    <div className={`border-l-2 ${borderColor} rounded-r-lg bg-zinc-900 p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-200">{message.sender_name}</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
              {message.room_name}
            </span>
            <span className="text-xs text-zinc-500">{date} {time}</span>
            <RelevanceBadge score={message.relevance_score} />
          </div>
          <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">{message.body}</p>
          {message.contribution_flag === 1 && message.contribution_hint && (
            <div className="mt-2 rounded bg-emerald-950/50 border border-emerald-800 px-3 py-1.5 text-xs text-emerald-300">
              Contribution opportunity: {message.contribution_hint}
            </div>
          )}
          {topics.length > 0 && (
            <div className="mt-2 flex gap-1 flex-wrap">
              {topics.map((t: string) => (
                <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
