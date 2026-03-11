"use client";

interface StarButtonProps {
  active: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  label: string;
  compact?: boolean;
  className?: string;
}

export function StarButton({
  active,
  onClick,
  label,
  compact = false,
  className = "",
}: StarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? `Unstar ${label}` : `Star ${label}`}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition ${
        active
          ? "border-amber-400/60 bg-amber-950/40 text-amber-200"
          : "border-slate-700/60 bg-slate-950/70 text-slate-400 hover:border-slate-500 hover:text-slate-200"
      } ${compact ? "min-h-8 min-w-8 justify-center px-2" : ""} ${className}`.trim()}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m12 3.75 2.546 5.16 5.694.827-4.12 4.015.972 5.671L12 16.744l-5.092 2.679.973-5.671-4.12-4.015 5.693-.827L12 3.75Z"
        />
      </svg>
      {!compact ? <span>{active ? "Starred" : "Star"}</span> : null}
    </button>
  );
}
