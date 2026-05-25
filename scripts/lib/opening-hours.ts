/**
 * Sanitise an OSM `opening_hours` string against degenerate values that
 * upstream data sometimes carries.
 *
 * Main offender: `00:00-00:00` (a zero-length range). Mappers reach for
 * it when they mean either "open 24/7" (canonical: `24/7` or
 * `Mo-Su 00:00-24:00`) or "always closed" (canonical: `closed`). The
 * opening_hours.js parser can't make sense of it either way, and the
 * downstream consumer ends up rendering "Öffnungszeiten unbekannt"
 * alongside the raw degenerate string — worse UX than no hours at all.
 *
 * Rule: if the string contains any `HH:MM-HH:MM` range, at least one of
 * those ranges must be a real (non-zero-length) interval. If every range
 * is `00:00-00:00`, return null. Strings with no `HH:MM` ranges at all
 * (e.g. `24/7`, `closed`, `PH off`) pass through unchanged — they're
 * either canonical or a problem for the consumer, not for us.
 */
export function cleanOpeningHours(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ranges = trimmed.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g);
  if (!ranges || ranges.length === 0) return trimmed;
  const allDegenerate = ranges.every((r) => /^0?0:00\s*-\s*0?0:00$/.test(r));
  return allDegenerate ? null : trimmed;
}
