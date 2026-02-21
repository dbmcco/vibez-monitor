interface StatusPanelProps {
  title: string;
  detail?: string;
  loading?: boolean;
}

export function StatusPanel({ title, detail, loading = false }: StatusPanelProps) {
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
    </div>
  );
}
