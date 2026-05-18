"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PRIMARY_LINKS = [
  { href: "/atlas", label: "Atlas" },
  { href: "/links", label: "Links" },
  { href: "/stats", label: "Stats" },
  { href: "/spaces", label: "Groups" },
];

export function Nav() {
  const pathname = usePathname() || "/atlas";

  return (
    <nav className="sticky top-0 z-40 border-b-4 border-double border-[#1f1a12] bg-[#f8f4ea]/95 px-4 py-3 text-[#1f1a12] shadow-sm backdrop-blur sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Link href="/atlas" className="inline-flex items-baseline gap-3">
              <span className="font-serif text-3xl font-black tracking-normal text-[#1f1a12] sm:text-4xl">
                The Vibez Atlas
              </span>
              <span className="hidden text-[11px] font-bold uppercase tracking-[0.18em] text-[#8b5f21] sm:inline">
                AGI Channels Daily
              </span>
            </Link>
            <p className="mt-1 text-xs leading-5 text-[#5e5238]">
              A sourced newspaper for what happened, what it means, and what deserves action.
            </p>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto border-y border-[#cbbf9d] py-2 lg:border-y-0 lg:py-0">
            {PRIMARY_LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`whitespace-nowrap border px-3 py-1.5 text-sm font-bold uppercase tracking-[0.12em] transition ${
                    active
                      ? "border-[#1f1a12] bg-[#1f1a12] text-[#f8f4ea]"
                      : "border-transparent text-[#342a1b] hover:border-[#1f1a12]"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
            <Link
              href="/settings"
              className="whitespace-nowrap px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[#786846] hover:text-[#1f1a12]"
            >
              Settings
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
