/**
 * Shared field normalizers for Featured.com payloads.
 *
 * Featured exposes the SAME logical field under different key casings across its
 * endpoints (`/opportunities-list` vs `/premium-question-list`). Both ingestion
 * paths MUST normalize through these helpers so a field present under any known
 * alias is captured — never dropped because one route only looked for one key.
 * (The "Unknown outlet" bronze defect was exactly this: the premium pass-through
 * never normalized `mediaOutlet`, so any non-`mediaOutlet` alias was lost.)
 */

export function safeParseDate(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** First non-empty string value among the given keys, else null. */
export function readStr(
  o: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/** First integer-coercible value among the given keys, else null. */
export function readInt(
  o: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const k of keys) {
    const raw = o[k];
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

/** First date-parseable value among the given keys, else null. */
export function readDate(
  o: Record<string, unknown>,
  ...keys: string[]
): Date | null {
  for (const k of keys) {
    const d = safeParseDate(o[k]);
    if (d) return d;
  }
  return null;
}

/**
 * Candidate keys Featured may use for the media outlet, ordered by likelihood.
 * Shared by BOTH the opportunities and premium ingestion paths so outlet
 * coverage is symmetric. Add aliases here once, not per-route.
 */
export const MEDIA_OUTLET_KEYS = [
  "mediaOutlet",
  "media_outlet",
  "outlet",
  "publication",
  "publisher",
] as const;
