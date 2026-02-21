export function RelevanceBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) return null;
  const color =
    score >= 8
      ? "badge-hot"
      : score >= 5
        ? "badge-warm"
        : "badge-archive";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono ${color}`}
    >
      {score}
    </span>
  );
}
