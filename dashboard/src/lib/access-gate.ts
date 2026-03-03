const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_COOKIE_NAME = "vibez_access_token";
const DEFAULT_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 14;
const TOKEN_SALT = "vibez-access-gate-v1";

function textToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isAccessGateEnabled(): boolean {
  const code = process.env.VIBEZ_ACCESS_CODE;
  return typeof code === "string" && code.trim().length > 0;
}

export function getAccessCode(): string {
  return (process.env.VIBEZ_ACCESS_CODE || "").trim();
}

export function getAccessCookieName(): string {
  const configured = (process.env.VIBEZ_ACCESS_COOKIE_NAME || "").trim();
  return configured || DEFAULT_COOKIE_NAME;
}

export function getAccessCookieTtlSeconds(): number {
  const raw = Number.parseInt(process.env.VIBEZ_ACCESS_COOKIE_TTL_SECONDS || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COOKIE_TTL_SECONDS;
  return raw;
}

export function isSecureAccessCookieEnabled(): boolean {
  const raw = process.env.VIBEZ_ACCESS_COOKIE_SECURE;
  if (raw === undefined) return process.env.NODE_ENV === "production";
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

export async function deriveAccessToken(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const payload = encoder.encode(`${code}|${TOKEN_SALT}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return textToHex(new Uint8Array(digest));
}

export async function expectedAccessToken(): Promise<string | null> {
  const code = getAccessCode();
  if (!code) return null;
  return deriveAccessToken(code);
}

export async function isValidAccessToken(token: string | undefined): Promise<boolean> {
  if (!isAccessGateEnabled()) return true;
  if (!token) return false;
  const expected = await expectedAccessToken();
  return Boolean(expected && token === expected);
}
