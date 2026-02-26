interface StatusPanelProps {
  title: string;
  detail?: string;
  loading?: boolean;
  steps?: string[];
}

export function StatusPanel({ title, detail, loading = false, steps = [] }: StatusPanelProps) {
  return (
    <div
      className="vibe-panel rounded-xl p-5 text-slate-300"
      role="status"
      aria-live={loading ? "polite" : undefined}
      aria-busy={loading || undefined}
    >
      <div className="flex items-center gap-3">
        {loading && (
          <span
            className="vibe-spinner h-4 w-4 rounded-full border-2 border-cyan-300/40 border-t-cyan-300"
            aria-hidden="true"
          />
        )}
        <p className="text-sm font-medium text-slate-200">{title}</p>
      </div>
      {detail && <p className="mt-2 text-sm text-slate-400">{detail}</p>}
      {steps.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-slate-400">
          {steps.map((step) => (
            <li key={step} className="flex items-start gap-2">
              <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-cyan-300/80" />
              <span>{step}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
