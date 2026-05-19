export function cleanAtlasReaderText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|pre|code|li|ul|ol)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\([^()]*\bvibez:(?:message|link):[^()]*\)/g, "")
    .replace(/\bvibez:(?:message|link):\S+/g, "")
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
