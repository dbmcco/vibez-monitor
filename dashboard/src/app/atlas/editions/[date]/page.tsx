import AtlasClient from "../../AtlasClient";
import Link from "next/link";
import { readAtlasArtifact } from "@/lib/atlas-artifact";
import { parseAtlasWindowHours } from "@/lib/atlas-ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ date: string }> | { date: string };
  searchParams?: Promise<{ hours?: string | string[]; images?: string | string[] }> |
    { hours?: string | string[]; images?: string | string[] };
};

async function resolveMaybe<T>(value: Promise<T> | T): Promise<T> {
  return value;
}

export default async function AtlasEditionPage({ params, searchParams }: PageProps) {
  const resolvedParams = await resolveMaybe(params);
  const resolvedSearchParams = searchParams ? await resolveMaybe(searchParams) : {};
  const rawHours = Array.isArray(resolvedSearchParams.hours)
    ? resolvedSearchParams.hours[0]
    : resolvedSearchParams.hours;
  const rawImages = Array.isArray(resolvedSearchParams.images)
    ? resolvedSearchParams.images[0]
    : resolvedSearchParams.images;
  const windowHours = parseAtlasWindowHours(rawHours);
  const artifact = await readAtlasArtifact(windowHours, resolvedParams.date);
  if (!artifact) {
    return (
      <main className="newspaper-section atlas-newspaper fade-up space-y-5">
        <Link
          href="/atlas/editions"
          className="inline-flex border border-[#cbbf9d] bg-[#f8f4ea] px-3 py-1.5 text-sm !text-[#342a1b]"
        >
          Back to editions
        </Link>
        <section className="border border-[#d6cdbb] bg-[#f8f4ea] p-5 text-[#342a1b]">
          <p className="newspaper-kicker">Edition unavailable</p>
          <h1 className="mt-2 font-serif text-4xl font-black text-[#1f1a12]">
            No saved Atlas edition for {resolvedParams.date}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5e5238]">
            The archive only opens stored publications. This date is not present in the local
            edition archive for the selected window.
          </p>
        </section>
      </main>
    );
  }

  return (
    <AtlasClient
      initialAtlas={artifact.atlas}
      initialEditorialReport={artifact.editorial_report}
      initialWindowHours={windowHours}
      hideArticleImages={rawImages === "off"}
    />
  );
}
