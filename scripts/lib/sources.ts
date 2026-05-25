/**
 * Per-field source-precedence helpers.
 *
 * Each feature can carry a `properties.sources_by_field` map from
 * dotted field path → source name. Writers check `canWrite()` before
 * setting a value and `stamp()` after, so a later, lower-trust source
 * (e.g. an OSM rescrape) doesn't overwrite a higher-trust value
 * (e.g. a Google-confirmed time).
 *
 * Ranks (low → high):
 *   hopfenstop  community seed, often years out of date
 *   osm         community-tagged, mostly fresh, occasionally stale
 *   photon      reverse-geocoded from OSM — same trust as `osm`
 *   apple       Apple Place page (Apple Maps editorial)
 *   google      Google Maps (owner-confirmed in most cases)
 *   user        explicit human edit in this repo — final word
 *
 * A new write succeeds when its rank is ≥ the existing field's rank.
 * `>=` (not `>`): a later poll from the same source should refresh
 * its own previous value; otherwise stale Google data would never
 * get re-confirmed.
 *
 * Unknown source (no entry in `sources_by_field` yet) defaults to
 * `osm`-tier — most pre-tracking data came from the OSM scrape or
 * the hopfenstop import, and treating it mid-trust lets enrichment
 * progress without trampling hopfenstop-specific fields that the
 * backfill script (`_oneoff/backfill-source-attribution.ts`) will
 * mark explicitly.
 */

export const SOURCE_RANK = {
  hopfenstop: 1,
  osm: 2,
  photon: 2,
  apple: 3,
  google: 4,
  user: 5,
} as const;

export type SourceName = keyof typeof SOURCE_RANK;

const DEFAULT_RANK = SOURCE_RANK.osm;

export function rankOf(source: string | undefined | null): number {
  if (!source) return DEFAULT_RANK;
  return (SOURCE_RANK as Record<string, number>)[source] ?? 0;
}

export function fieldSource(
  sbf: Record<string, string> | undefined,
  path: string,
): string | undefined {
  return sbf?.[path];
}

export function canWrite(
  sbf: Record<string, string> | undefined,
  path: string,
  newSource: SourceName,
): boolean {
  return rankOf(newSource) >= rankOf(sbf?.[path]);
}

/**
 * Record that `path` was last written by `source`. Mutates `props.sources_by_field`,
 * creating it on first use.
 */
export function stamp(
  props: { sources_by_field?: Record<string, string> } & Record<string, unknown>,
  path: string,
  source: SourceName,
): void {
  const sbf = props.sources_by_field ?? (props.sources_by_field = {});
  sbf[path] = source;
}

/**
 * Stamp a whole batch of paths at once. Convenience for writers that touch
 * many fields with the same provenance (e.g. the OSM scrape stamping every
 * field of a fresh feature as `osm`).
 */
export function stampAll(
  props: { sources_by_field?: Record<string, string> } & Record<string, unknown>,
  paths: readonly string[],
  source: SourceName,
): void {
  const sbf = props.sources_by_field ?? (props.sources_by_field = {});
  for (const p of paths) sbf[p] = source;
}
