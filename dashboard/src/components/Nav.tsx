"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Briefing" },
  { href: "/contribute", label: "Contribute" },
  { href: "/stats", label: "Stats" },
  { href: "/chat", label: "Chat" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const activeLabel = links.find((link) => link.href === pathname)?.label ?? "Briefing";
  return (
    <nav className="sticky top-0 z-40 border-b border-slate-700/50 bg-slate-950/75 px-4 py-4 backdrop-blur-xl sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="group inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.9)] transition-transform group-hover:scale-110" />
            <span className="vibe-title text-base tracking-[0.08em] text-slate-100">
              VIBEZ MONITOR
            </span>
          </Link>
          <span className="vibe-chip rounded px-2 py-0.5 text-xs sm:hidden">
            Now: {activeLabel}
          </span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 sm:pb-0">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`vibe-nav-item rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${
                pathname === link.href
                  ? "vibe-nav-item-active"
                  : ""
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
        <span className="vibe-chip hidden rounded px-2 py-0.5 text-xs sm:inline-flex">
          Now: {activeLabel}
        </span>
      </div>
    </nav>
  );
}
