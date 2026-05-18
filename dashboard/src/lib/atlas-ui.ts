const SUPPORTED_ATLAS_WINDOWS = new Set([48, 168]);

export function parseAtlasWindowHours(value: string | null | undefined): number {
  const parsed = Number(value);
  if (SUPPORTED_ATLAS_WINDOWS.has(parsed)) return parsed;
  return 48;
}

export function atlasArticleHref(issueDate: string, slug: string, hours: number): string {
  const params = new URLSearchParams({ hours: String(parseAtlasWindowHours(String(hours))) });
  return `/atlas/issues/${encodeURIComponent(issueDate)}/${encodeURIComponent(slug)}?${params.toString()}`;
}

export function atlasFrontPageHref(hours: number): string {
  const params = new URLSearchParams({ hours: String(parseAtlasWindowHours(String(hours))) });
  return `/atlas?${params.toString()}`;
}

export function isRenderableArticleImageUrl(value: string | null | undefined): value is string {
  const url = value?.trim();
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  if (url.startsWith("data:image/")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
