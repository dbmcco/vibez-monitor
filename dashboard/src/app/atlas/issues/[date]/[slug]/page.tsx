import AtlasArticleClient from "./ArticleClient";
import { atlasArticleDeepDiveHref, parseAtlasWindowHours } from "@/lib/atlas-ui";
import { readAtlasArtifact } from "@/lib/atlas-artifact";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ date: string; slug: string }> | { date: string; slug: string };
  searchParams?: Promise<{ hours?: string | string[] }> | { hours?: string | string[] };
};

async function resolveMaybe<T>(value: Promise<T> | T): Promise<T> {
  return value;
}

export default async function AtlasArticlePage({ params, searchParams }: PageProps) {
  const resolvedParams = await resolveMaybe(params);
  const resolvedSearchParams = searchParams ? await resolveMaybe(searchParams) : {};
  const rawHours = Array.isArray(resolvedSearchParams.hours)
    ? resolvedSearchParams.hours[0]
    : resolvedSearchParams.hours;
  const windowHours = parseAtlasWindowHours(rawHours);
  const artifact = readAtlasArtifact(windowHours);

  return (
    <AtlasArticleClient
      articleDate={resolvedParams.date}
      articleSlug={resolvedParams.slug}
      deepDiveHref={atlasArticleDeepDiveHref(resolvedParams.date, resolvedParams.slug, windowHours)}
      initialWindowHours={windowHours}
      initialPayload={artifact
        ? {
          atlas: artifact.atlas,
          editorial_report: artifact.editorial_report,
          editorial_error: artifact.editorial_error,
        }
        : null}
    />
  );
}
