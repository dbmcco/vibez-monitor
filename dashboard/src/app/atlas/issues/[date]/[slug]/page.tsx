import AtlasArticleClient from "./ArticleClient";
import { generateAtlasDeeperDive, type AtlasDeeperDive } from "@/lib/atlas-deeper-dive";
import { atlasArticleDeepDiveHref, parseAtlasWindowHours } from "@/lib/atlas-ui";
import { readAtlasArtifact } from "@/lib/atlas-artifact";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ date: string; slug: string }> | { date: string; slug: string };
  searchParams?: Promise<{ deepDive?: string | string[]; hours?: string | string[] }> | {
    deepDive?: string | string[];
    hours?: string | string[];
  };
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
  const rawDeepDive = Array.isArray(resolvedSearchParams.deepDive)
    ? resolvedSearchParams.deepDive[0]
    : resolvedSearchParams.deepDive;
  const windowHours = parseAtlasWindowHours(rawHours);
  const artifact = readAtlasArtifact(windowHours);
  const article = artifact?.editorial_report.articles.find((item) =>
    item.slug === resolvedParams.slug,
  ) || null;
  let initialDeepDive: AtlasDeeperDive | null = null;
  let initialDeepDiveError: string | null = null;
  if (rawDeepDive === "1" && article) {
    try {
      initialDeepDive = await generateAtlasDeeperDive({ article, hours: windowHours });
    } catch (error) {
      initialDeepDiveError = error instanceof Error
        ? error.message
        : "Deeper dive unavailable.";
    }
  }

  return (
    <AtlasArticleClient
      articleDate={resolvedParams.date}
      articleSlug={resolvedParams.slug}
      deepDiveHref={atlasArticleDeepDiveHref(resolvedParams.date, resolvedParams.slug, windowHours)}
      initialWindowHours={windowHours}
      initialDeepDive={initialDeepDive}
      initialDeepDiveError={initialDeepDiveError}
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
