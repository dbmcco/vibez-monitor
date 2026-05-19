import AtlasClient from "./AtlasClient";
import { readAtlasArtifact } from "@/lib/atlas-artifact";
import { parseAtlasWindowHours } from "@/lib/atlas-ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AtlasPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const resolvedSearchParams = (searchParams ? await searchParams : {}) as SearchParams;
  const requestedHours = Array.isArray(resolvedSearchParams.hours)
    ? resolvedSearchParams.hours[0]
    : resolvedSearchParams.hours;
  const requestedImages = Array.isArray(resolvedSearchParams.images)
    ? resolvedSearchParams.images[0]
    : resolvedSearchParams.images;
  const windowHours = parseAtlasWindowHours(requestedHours);
  const artifact = await readAtlasArtifact(windowHours);
  return (
    <AtlasClient
      initialAtlas={artifact?.atlas || null}
      initialEditorialReport={artifact?.editorial_report || null}
      initialWindowHours={windowHours}
      hideArticleImages={requestedImages === "off"}
    />
  );
}
