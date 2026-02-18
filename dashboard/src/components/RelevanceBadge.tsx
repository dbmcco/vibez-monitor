export function RelevanceBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) return null;
  const color =
    score >= 8
      ? "bg-red-900/50 text-red-300 border-red-800"
      : score >= 5
        ? "bg-amber-900/50 text-amber-300 border-amber-800"
        : "bg-zinc-800/50 text-zinc-400 border-zinc-700";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-mono ${color}`}>
      {score}
    </span>
  );
}
