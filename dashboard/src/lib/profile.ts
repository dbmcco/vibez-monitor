import path from "path";

const DEFAULT_SUBJECT_NAME = "User";
const DEFAULT_SUBJECT_ALIASES: string[] = [];

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    deduped.push(cleaned);
  }
  return deduped;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandHomePath(rawPath: string): string {
  if (rawPath === "~") {
    return process.env.HOME || rawPath;
  }
  if (rawPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) return rawPath;
    return path.join(home, rawPath.slice(2));
  }
  return rawPath;
}

export function getSubjectName(): string {
  const raw = process.env.VIBEZ_SUBJECT_NAME;
  const cleaned = raw ? raw.trim() : "";
  return cleaned || DEFAULT_SUBJECT_NAME;
}

export function getSubjectPossessive(subjectName = getSubjectName()): string {
  const cleaned = subjectName.trim() || DEFAULT_SUBJECT_NAME;
  return cleaned.toLowerCase().endsWith("s") ? `${cleaned}'` : `${cleaned}'s`;
}

export function getSubjectAliases(subjectName = getSubjectName()): string[] {
  const aliases = [subjectName];
  const rawAliases = process.env.VIBEZ_SELF_ALIASES;
  if (rawAliases !== undefined) {
    aliases.push(
      ...rawAliases
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  } else if (subjectName.toLowerCase() === DEFAULT_SUBJECT_NAME.toLowerCase()) {
    aliases.push(...DEFAULT_SUBJECT_ALIASES);
  }
  return uniqueCaseInsensitive(aliases);
}

export function buildSelfMentionRegex(): RegExp {
  const aliasTerms = getSubjectAliases()
    .map((alias) => escapeRegex(alias))
    .filter((alias) => alias.length > 0);
  if (aliasTerms.length === 0) {
    return /\b\B/;
  }
  return new RegExp(`\\b(?:${aliasTerms.join("|")})\\b`, "i");
}

export function getDossierPath(): string {
  const raw = process.env.VIBEZ_DOSSIER_PATH;
  const cleaned = raw ? raw.trim() : "";
  if (cleaned) {
    return expandHomePath(cleaned);
  }
  const home = process.env.HOME || "";
  return path.join(home, ".dossier", "context.json");
}
