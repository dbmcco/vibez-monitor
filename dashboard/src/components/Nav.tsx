"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/chat", label: "Chat" },
  { href: "/briefing", label: "Briefing" },
  { href: "/contribute", label: "Contribute" },
  { href: "/stats", label: "Stats" },
  { href: "/settings", label: "Settings" },
];

const PAGE_INTENT: Record<string, string> = {
  "/": "Rapid synthesis: ask focused questions and get grounded answers from message history.",
  "/briefing":
    "Executive signal first: what changed, why it matters, and where to pay attention.",
  "/contribute":
    "Action queue: highest-value contributions filtered by urgency, need, and relationship leverage.",
  "/stats":
    "Pattern analysis: trends by user, channel, and topic with drilldown detail.",
  "/chat":
    "Rapid synthesis: ask focused questions and get grounded answers from message history.",
  "/settings": "System controls: tune data scope, models, and analysis behavior.",
};

export function Nav() {
  const pathname = usePathname();
  const activeLabel = links.find((link) => link.href === pathname)?.label ?? "Chat";
  const activeIntent = PAGE_INTENT[pathname] ?? PAGE_INTENT["/"];
  return (
    <nav className="sticky top-0 z-40 border-b border-slate-700/50 bg-slate-950/75 px-4 py-4 backdrop-blur-xl sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between gap-3">
            <Link href="/" className="group inline-flex items-center gap-2">
              <Image
                src="/icons/favicon-32x32.png"
                alt="Vibez logo"
                width={20}
                height={20}
                className="h-5 w-5 rounded-[6px] border border-cyan-300/45 shadow-[0_0_14px_rgba(34,211,238,0.55)] transition-transform group-hover:scale-105"
              />
              <span className="vibe-title text-base tracking-[0.08em] text-slate-100">
                VIBEZ MONITOR
              </span>
            </Link>
            <span className="vibe-chip rounded px-2 py-0.5 text-xs sm:hidden">
              Focus: {activeLabel}
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
            Focus: {activeLabel}
          </span>
        </div>
        <div className="mt-2 rounded border border-slate-700/60 bg-slate-900/45 px-3 py-2 text-xs text-slate-300">
          <span className="mr-2 text-slate-500">Intent:</span>
          {activeIntent}
        </div>
      </div>
    </nav>
  );
}
