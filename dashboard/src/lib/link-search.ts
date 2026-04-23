function normalizeLinkSearchTerm(raw: string): string {
  const withStraightQuotes = raw.replaceAll("’", "'");
  const trimmed = withStraightQuotes.replace(/^[^\p{L}\p{N}:/._-]+|[^\p{L}\p{N}:/._-]+$/gu, "");
  const withoutPossessive = trimmed.replace(/'s$/i, "");
  return withoutPossessive.replaceAll("'", "");
}

export function normalizeLinkSearchTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .trim()
        .split(/\s+/)
        .map(normalizeLinkSearchTerm)
        .filter(Boolean),
    ),
  );
}

export function buildLinksFtsQuery(query: string): string | null {
  const terms = normalizeLinkSearchTerms(query);
  if (!terms.length) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}
