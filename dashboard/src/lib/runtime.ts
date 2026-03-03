const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envBool(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

export function isPublicMode(): boolean {
  return envBool(
    process.env.NEXT_PUBLIC_VIBEZ_PUBLIC_MODE || process.env.VIBEZ_PUBLIC_MODE,
    false,
  );
}

