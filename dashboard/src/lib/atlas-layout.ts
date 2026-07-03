export interface AtlasFrontPageArticleLike {
  role: "lead" | "secondary";
  slug: string;
}

export function splitFrontPageArticles<T extends AtlasFrontPageArticleLike>(articles: T[]): {
  lead: T | null;
  left: T[];
  right: T[];
  overflow: T[];
} {
  const lead = articles.find((article) => article.role === "lead") || articles[0] || null;
  const secondary = articles.filter((article) => article.slug !== lead?.slug);
  return {
    lead,
    left: secondary.slice(0, 2),
    right: secondary.slice(2, 4),
    overflow: secondary.slice(4),
  };
}
