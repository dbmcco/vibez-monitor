import AtlasClient from "../../AtlasClient";
import { readAtlasArtifact } from "@/lib/atlas-artifact";
import { parseAtlasWindowHours } from "@/lib/atlas-ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ date: string }> | { date: string };
  searchParams?: Promise<{ hours?: string | string[] }> | { hours?: string | string[] };
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
  const windowHours = parseAtlasWindowHours(rawHours);
  const artifact = await readAtlasArtifact(windowHours, resolvedParams.date);

  return (
    <AtlasClient
      initialAtlas={artifact?.atlas || null}
      initialEditorialReport={artifact?.editorial_report || null}
      initialWindowHours={windowHours}
    />
  );
}
