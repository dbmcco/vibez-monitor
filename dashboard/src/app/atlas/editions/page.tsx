import Link from "next/link";
import { redirect } from "next/navigation";

import { listAtlasEditions } from "@/lib/atlas-artifact";
import { parseAtlasWindowHours } from "@/lib/atlas-ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Record<string, string | string[] | undefined>;

async function resolveMaybe<T>(value: Promise<T> | T): Promise<T> {
  return value;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function EditionList({
  title,
  editions,
}: {
  title: string;
  editions: Awaited<ReturnType<typeof listAtlasEditions>>;
}) {
  return (
    <section className="border-t border-[#cbbf9d] pt-5">
      <h2 className="font-serif text-2xl font-black text-[#1f1a12]">{title}</h2>
      {editions.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-[#5e5238]">No saved editions in this section yet.</p>
      ) : (
        <div className="mt-3 divide-y divide-[#d6caab] border-y border-[#cbbf9d]">
          {editions.map((edition) => (
            <Link
              key={`${edition.type}-${edition.date}-${edition.window_hours}`}
              href={edition.href}
              className="grid gap-2 px-1 py-4 text-[#1f1a12] hover:bg-[#fffaf0]/75 sm:grid-cols-[9rem_1fr_auto]"
            >
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#7b2f20]">
                  {edition.edition_label}
                </p>
                <p className="mt-1 font-serif text-xl font-black">{edition.date}</p>
              </div>
              <div className="min-w-0">
                <p className="font-serif text-xl font-bold">{edition.title}</p>
                {edition.subtitle ? (
                  <p className="mt-1 text-sm leading-6 text-[#5e5238]">{edition.subtitle}</p>
                ) : null}
              </div>
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b5f21] sm:text-right">
                {edition.window_hours === 168 ? "Week" : "48h"}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function AtlasEditionsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const resolvedSearchParams = searchParams ? await resolveMaybe(searchParams) : {};
  const requestedDate = firstParam(resolvedSearchParams.date);
  if (requestedDate) {
    const hours = parseAtlasWindowHours(firstParam(resolvedSearchParams.hours));
    redirect(`/atlas/editions/${encodeURIComponent(requestedDate)}?hours=${hours}`);
  }

  const editions = await listAtlasEditions({ includeAllTypes: true, limit: 60 });
  const dailyEditions = editions.filter((edition) => edition.type === "daily");
  const sundayEditions = editions.filter((edition) => edition.type === "sunday_review");
  const latestDate = editions[0]?.date || new Date().toISOString().slice(0, 10);

  return (
    <main className="newspaper-section atlas-newspaper fade-up space-y-6">
      <header className="newspaper-section-header space-y-3">
        <p className="newspaper-kicker">Archive Room</p>
        <h1 className="vibe-title text-4xl sm:text-5xl">Atlas Editions</h1>
        <p className="vibe-subtitle max-w-3xl text-base leading-7">
          Every saved issue is a durable publication. Opening an older date reads the stored edition
          and its article pages; it does not ask the newsroom to rewrite history.
        </p>
      </header>

      <form
        action="/atlas/editions"
        method="get"
        className="flex flex-wrap items-end gap-3 border border-[#cbbf9d] bg-[#fffaf0]/55 p-3"
      >
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.12em] text-[#7b2f20]">
          Open date
          <input
            type="date"
            name="date"
            defaultValue={latestDate}
            className="min-h-10 border border-[#b9aa84] bg-[#fffaf0] px-3 text-sm font-normal normal-case tracking-normal text-[#1f1a12]"
          />
        </label>
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.12em] text-[#7b2f20]">
          Edition
          <select
            name="hours"
            defaultValue="48"
            className="min-h-10 border border-[#b9aa84] bg-[#fffaf0] px-3 text-sm font-normal normal-case tracking-normal text-[#1f1a12]"
          >
            <option value="48">48h daily</option>
            <option value="168">Week in review</option>
          </select>
        </label>
        <button
          type="submit"
          className="min-h-10 border border-[#1f1a12] bg-[#1f1a12] px-4 text-xs font-bold uppercase tracking-[0.14em] text-[#f8f4ea]"
        >
          Open edition
        </button>
      </form>

      <EditionList title="Daily Papers" editions={dailyEditions} />
      <EditionList title="Sunday Editions" editions={sundayEditions} />
    </main>
  );
}
