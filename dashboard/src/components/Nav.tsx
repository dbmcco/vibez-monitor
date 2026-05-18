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
    <nav className="sticky top-0 z-40 border-b border-[#1f1a12] bg-[#f8f4ea]/95 px-4 py-3 text-[#1f1a12] backdrop-blur sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <Link href="/atlas" className="inline-flex items-baseline gap-3">
              <span className="font-serif text-3xl font-black tracking-normal text-[#1f1a12] sm:text-[2.6rem]">
                The Vibez Atlas
              </span>
              <span className="hidden rounded-full border border-[#cbbf9d] px-2 py-0.5 text-[10px] font-bold uppercase text-[#8b5f21] sm:inline">
                Daily
              </span>
            </Link>
            <p className="mt-1 max-w-xl text-xs leading-5 text-[#5e5238]">
              A sourced newspaper for what happened, what it means, and what deserves action.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1 border-t border-[#d8cba9] pt-2 lg:border-t-0 lg:pt-0">
            {PRIMARY_LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`whitespace-nowrap border px-2.5 py-1.5 text-xs font-bold uppercase transition sm:px-3 ${
                    active
                      ? "border-[#1f1a12] bg-[#1f1a12] text-[#f8f4ea]"
                      : "border-transparent text-[#342a1b] hover:border-[#b9aa86] hover:bg-[#fffaf0]/55"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
            <Link
              href="/settings"
              className="whitespace-nowrap border border-transparent px-2.5 py-1.5 text-xs font-bold uppercase text-[#786846] hover:border-[#b9aa86] hover:bg-[#fffaf0]/55 hover:text-[#1f1a12] sm:px-3"
            >
              Settings
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
