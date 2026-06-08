/**
 * Weekly OSM ingest orchestrator.
 *
 * For each region:
 *   1. Fetch fresh OSM features
 *   2. Merge with the existing region file:
 *        - Non-OSM (human / hopfenstop) features are preserved verbatim
 *        - Features whose sources include an OSM entry are matched by id;
 *          updated if still present in Overpass, marked osm_removed=true if not
 *        - New OSM features are appended
 *   3. Write the file (idempotent: features sorted by id, non-OSM first)
 *
 * Returns counts via stdout so the GH Action can include them in the PR title.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { fetchOsmForRegion, loadRegions, ownsFeature, type OsmFeature, type Region } from "./osm-to-geojson.ts";
import { rankOf } from "./lib/sources.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    sources?: Array<{ type: string; id: string; version?: number }>;
    osm_removed?: boolean;
    [k: string]: unknown;
  };
}

interface Stats {
  region: string;
  added: number;
  updated: number;
  removed: number;
  kept_non_osm: number;
  /** Genuine new OSM POIs we suppressed because there was a near-duplicate
   *  existing feature (same area + similar name) that just isn't linked to
   *  an OSM source yet. Without this, hopfenstop-only features would get
   *  shadowed by their OSM twins on every scrape run. */
  suppressed_dup: number;
  /** OSM POIs that fell inside this region's bbox but are geographically
   *  closer to another region (e.g. Düsseldorf's Wittlaer caught by Ruhr's
   *  bbox). We drop them here so the same OSM node doesn't land in two
   *  region files. Also counts pre-existing wrong-region copies that this
   *  pass removes. */
  cross_region_dropped: number;
}

// Near-duplicate dedup: 30 m radius, Dice ≥ 0.6 on normalised names.
// Matches the enrichment script's "uncertain-or-better" threshold.
const DEDUP_RADIUS_M = 30;
const DEDUP_NAME_SIM = 0.6;

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(kiosk|trinkhalle|wasserhaeuschen|spaeti|spaetkauf|laden|shop|store)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function diceCoef(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const ag = bigrams(a);
  const bg = bigrams(b);
  if (ag.length === 0 || bg.length === 0) return 0;
  const aMap = new Map<string, number>();
  for (const g of ag) aMap.set(g, (aMap.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of bg) {
    const n = aMap.get(g);
    if (n && n > 0) { inter++; aMap.set(g, n - 1); }
  }
  return (2 * inter) / (ag.length + bg.length);
}

function looksLikeDuplicateOf(candidate: OsmFeature, existing: Feature[]): boolean {
  const [cLng, cLat] = candidate.geometry.coordinates;
  const cName = normalise(candidate.properties.name ?? "");
  if (!cName) return false;
  for (const e of existing) {
    const [eLng, eLat] = e.geometry.coordinates;
    if (haversineMeters(cLat, cLng, eLat, eLng) > DEDUP_RADIUS_M) continue;
    const eName = normalise((e.properties["name"] as string) ?? "");
    if (!eName) continue;
    if (diceCoef(cName, eName) >= DEDUP_NAME_SIM) return true;
  }
  return false;
}

/**
 * Apply a fresh OSM feature on top of an existing OSM-only local feature.
 * Fresh wins for OSM-derived fields *unless* the local field has a higher
 * source rank in `sources_by_field` (e.g. an Apple-confirmed time or a
 * Google-confirmed payment block). Fields fresh doesn't populate (e.g.
 * upstream OSM has no addr:* tags but Photon backfilled an address) are
 * preserved from local unconditionally — losing data that the next OSM
 * refresh can't bring back is never the right call.
 *
 * Source-of-origin gets stamped per field so the next refresh has the
 * provenance it needs to decide all over again.
 */
function applyOsmRefresh(local: Feature, fresh: OsmFeature): OsmFeature {
  const lp = local.properties as Record<string, unknown>;
  const fp = fresh.properties as Record<string, unknown>;

  if (typeof lp["created"] === "string") fp["created"] = lp["created"];
  for (const k of ["apple_id_attempted", "apple_attempted", "google_attempted"]) {
    if (lp[k] !== undefined) fp[k] = lp[k];
  }

  const localSbf = (lp["sources_by_field"] as Record<string, string> | undefined) ?? {};
  const freshSbf =
    (fp["sources_by_field"] as Record<string, string> | undefined) ??
    ((fp["sources_by_field"] = {}) as Record<string, string>);

  const restoreAtomic = (path: string): void => {
    const lv = lp[path];
    if (lv === undefined) return;
    if (fp[path] === undefined) {
      // Fresh has no value for this path — keep local regardless of rank.
      fp[path] = lv;
      if (localSbf[path]) freshSbf[path] = localSbf[path];
      return;
    }
    if (rankOf(localSbf[path]) > rankOf(freshSbf[path])) {
      fp[path] = lv;
      freshSbf[path] = localSbf[path]!;
    }
  };

  restoreAtomic("name");
  restoreAtomic("description");
  restoreAtomic("hours");

  const restoreGroup = (group: "address" | "payment", keys: readonly string[]): void => {
    const fg = (fp[group] as Record<string, string> | undefined) ?? {};
    const lg = (lp[group] as Record<string, string> | undefined) ?? {};
    for (const k of keys) {
      const path = `${group}.${k}`;
      const lv = lg[k];
      if (lv === undefined || lv === "") continue;
      if (fg[k] === undefined || fg[k] === "") {
        fg[k] = lv;
        if (localSbf[path]) freshSbf[path] = localSbf[path];
      } else if (rankOf(localSbf[path]) > rankOf(freshSbf[path])) {
        fg[k] = lv;
        freshSbf[path] = localSbf[path]!;
      }
    }
    fp[group] = fg;
  };
  restoreGroup("address", ["street", "number", "postalcode", "city", "district"]);
  restoreGroup("payment", ["cash", "cards", "contactless", "girocard"]);

  // Tags: union, no precedence — different sources legitimately contribute
  // different tags about the same place.
  const tagsSet = new Set<string>([
    ...((lp["tags"] as string[] | undefined) ?? []),
    ...((fp["tags"] as string[] | undefined) ?? []),
  ]);
  if (tagsSet.size > 0) fp["tags"] = [...tagsSet].sort();

  // Sources: union local's non-OSM sources (hopfenstop, apple, gmaps) into
  // the fresh feature, keyed on type+id so a stale local OSM version
  // doesn't shadow the fresh one. Fresh has only the osm entry — for
  // OSM-only features that's a no-op; for hybrids this is what carries
  // hopfenstop/apple/gmaps across the refresh.
  type SourceEntry = { type: string; id: string; version?: number };
  const localSources = (lp["sources"] as SourceEntry[] | undefined) ?? [];
  const freshSources = (fp["sources"] as SourceEntry[] | undefined) ?? [];
  const seen = new Set(freshSources.map((s) => `${s.type}::${s.id ?? ""}`));
  for (const s of localSources) {
    const key = `${s.type}::${s.id ?? ""}`;
    if (!seen.has(key)) {
      freshSources.push(s);
      seen.add(key);
    }
  }
  fp["sources"] = freshSources;

  // osm_removed shouldn't survive — Overpass returned the feature this
  // run, so it's back.
  delete (fp as Record<string, unknown>)["osm_removed"];

  return fresh;
}

async function loadExisting(path: string): Promise<Feature[]> {
  if (!existsSync(path)) return [];
  const txt = await readFile(path, "utf8");
  const doc = JSON.parse(txt) as { features?: Feature[] };
  return doc.features ?? [];
}

function osmIdsFromSources(f: Feature): string[] {
  return (f.properties.sources ?? [])
    .filter((s) => s.type === "osm")
    .map((s) => s.id);
}

function isOsmOnly(f: Feature): boolean {
  const srcs = f.properties.sources ?? [];
  return srcs.length > 0 && srcs.every((s) => s.type === "osm");
}

async function processRegion(region: Region, allRegions: Region[]): Promise<Stats> {
  const path = resolve(REPO_ROOT, region.path);
  const existing = await loadExisting(path);
  const fresh = await fetchOsmForRegion(region);

  let crossRegionDropped = 0;

  const freshById = new Map<string, OsmFeature>();
  for (const f of fresh) {
    const osmId = f.properties.sources[0]?.id;
    if (!osmId) continue;
    const [lng, lat] = f.geometry.coordinates;
    if (!ownsFeature(region, allRegions, lng, lat)) {
      crossRegionDropped++;
      continue;
    }
    freshById.set(osmId, f);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  let keptNonOsm = 0;
  let suppressedDup = 0;

  const merged: Feature[] = [];
  // Tracks OSM source ids already emitted into `merged`, so a second existing
  // row sharing an OSM id collapses into the first instead of producing a
  // duplicate (the 22 within-file dupes mostly in frankfurt.geojson).
  const emittedOsmIds = new Set<string>();

  // Pass 1: walk existing features, dedup against fresh OSM data by id.
  //   - Anything with a matching fresh OSM id (osm-only or hybrid) goes
  //     through applyOsmRefresh — fresh wins for OSM-derived fields where
  //     sources_by_field allows, local Apple/Google/user data survives,
  //     and local non-osm sources (hopfenstop / apple / gmaps) get unioned
  //     onto the result.
  //   - OSM-only features whose id Overpass didn't return get marked
  //     osm_removed (or dropped on cross-region ownership).
  //   - Hybrid features whose id Overpass didn't return are kept verbatim:
  //     their other sources are still valid even if the OSM node is gone.
  //   - Pure non-OSM features are kept verbatim.
  for (const f of existing) {
    const osmIds = osmIdsFromSources(f);
    if (osmIds.some((id) => emittedOsmIds.has(id))) {
      // Within-file duplicate of an already-emitted feature. Drop it.
      continue;
    }
    let consumed = false;
    for (const id of osmIds) {
      if (freshById.has(id)) {
        const fr = applyOsmRefresh(f, freshById.get(id)!) as unknown as Feature;
        merged.push(fr);
        for (const sid of (fr.properties.sources ?? []) as Array<{ id: string }>) {
          if (sid.id) emittedOsmIds.add(sid.id);
        }
        consumed = true;
        freshById.delete(id);
      }
    }
    if (consumed) {
      updated++;
      continue;
    }
    if (osmIds.length > 0) {
      if (isOsmOnly(f)) {
        // OSM-only feature whose id wasn't in this region's fresh result:
        // either Overpass no longer returns it (kiosk closed / mistagged),
        // or it's geographically owned by a different region (legacy from
        // before ownsFeature filtering). The latter is identifiable by
        // checking the coords against the same ownership rule; if another
        // region owns it, delete it here — the owning region's scrape run
        // will keep its copy.
        const [lng, lat] = f.geometry.coordinates;
        if (!ownsFeature(region, allRegions, lng, lat)) {
          crossRegionDropped++;
          continue;
        }
        if (!f.properties.osm_removed) {
          f.properties.osm_removed = true;
          removed++;
        }
      }
      // Hybrid (osm + something else) or osm_removed: keep in place.
      merged.push(f);
      for (const id of osmIds) emittedOsmIds.add(id);
    } else {
      // Pure non-OSM feature (hopfenstop / user).
      merged.push(f);
      keptNonOsm++;
    }
  }

  // Pass 2: append genuinely-new OSM POIs, but skip ones that look like
  // duplicates of existing local features (same area + similar name). That
  // covers the un-enriched majority: hopfenstop features without an OSM
  // source attached. The next enrichment run can link them; until then,
  // we'd rather under-add than create dupes.
  for (const f of freshById.values()) {
    if (looksLikeDuplicateOf(f, merged)) {
      suppressedDup++;
      continue;
    }
    merged.push(f);
    added++;
  }

  // Stable order: non-OSM block first, then OSM block — both sorted by id so
  // the only diffs a scrape PR ever shows are real content changes, never
  // reorder churn from upstream Overpass results or enrichment passes.
  const byId = (a: Feature, b: Feature) => a.properties.id.localeCompare(b.properties.id);
  const nonOsm = merged.filter((f) => !isOsmOnly(f)).sort(byId);
  const osm = merged.filter(isOsmOnly).sort(byId);
  const sorted = [...nonOsm, ...osm];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ type: "FeatureCollection", features: sorted }, null, 2) + "\n",
    "utf8",
  );

  return {
    region: region.slug,
    added,
    updated,
    removed,
    kept_non_osm: keptNonOsm,
    suppressed_dup: suppressedDup,
    cross_region_dropped: crossRegionDropped,
  };
}

async function main(): Promise<void> {
  const wantSlug = process.argv[2];
  const regions = await loadRegions();
  const targets = wantSlug ? regions.filter((r) => r.slug === wantSlug) : regions;
  if (targets.length === 0) {
    console.error("No matching regions in regions.yml");
    process.exit(2);
  }
  // Cities before rest buckets: a rest scrape's ownsFeature check needs to
  // know city features are already claimed. The check itself is stateless
  // (just bbox + role), but ordering still matters for the existing-feature
  // pass that marks osm_removed / cross_region_dropped.
  targets.sort((a, b) => {
    const ar = (a.role ?? "city") === "rest" ? 1 : 0;
    const br = (b.role ?? "city") === "rest" ? 1 : 0;
    return ar - br;
  });
  const allStats: Stats[] = [];
  const failures: Array<{ region: string; error: string }> = [];
  for (const region of targets) {
    console.error(`→ ${region.slug}: querying Overpass…`);
    try {
      const stats = await processRegion(region, regions);
      console.error(`  +${stats.added} ~${stats.updated} -${stats.removed} (kept ${stats.kept_non_osm} non-OSM, suppressed ${stats.suppressed_dup} dup, cross-region dropped ${stats.cross_region_dropped})`);
      allStats.push(stats);
    } catch (err: unknown) {
      // A transient Overpass blip (504/timeout) on one region must not throw
      // away the dozens already refreshed this run. Skip it — the region's
      // existing data file is left untouched, and next week's sweep retries.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${region.slug} failed: ${msg} — skipping region, keeping existing data`);
      failures.push({ region: region.slug, error: msg });
    }
  }
  process.stdout.write(JSON.stringify(allStats, null, 2) + "\n");
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${targets.length} region(s) failed this run:`);
    for (const f of failures) console.error(`  - ${f.region}: ${f.error}`);
    // Stay green on partial failure so the good regions still commit; the
    // stderr summary above is the signal. Only hard-fail when nothing
    // succeeded — that means Overpass is wholesale down, not just flaky.
    if (allStats.length === 0) process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
