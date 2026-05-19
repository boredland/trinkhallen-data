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
 *   3. Write the file (idempotent: sorted by id within the OSM block)
 *
 * Returns counts via stdout so the GH Action can include them in the PR title.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { fetchOsmForRegion, loadRegions, type OsmFeature, type Region } from "./osm-to-geojson.ts";

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

async function processRegion(region: Region): Promise<Stats> {
  const path = resolve(REPO_ROOT, region.path);
  const existing = await loadExisting(path);
  const fresh = await fetchOsmForRegion(region);

  const freshById = new Map<string, OsmFeature>();
  for (const f of fresh) {
    const osmId = f.properties.sources[0]?.id;
    if (osmId) freshById.set(osmId, f);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  let keptNonOsm = 0;

  const merged: Feature[] = [];

  // First pass: keep non-OSM features verbatim, refresh OSM-matched ones, mark removed.
  for (const f of existing) {
    if (!isOsmOnly(f)) {
      merged.push(f);
      keptNonOsm++;
      continue;
    }
    const osmId = osmIdsFromSources(f)[0];
    if (osmId && freshById.has(osmId)) {
      const fresh = freshById.get(osmId)!;
      // Preserve original `created` if present.
      if (typeof f.properties["created"] === "string") {
        (fresh.properties as Record<string, unknown>)["created"] = f.properties["created"];
      }
      merged.push(fresh);
      freshById.delete(osmId);
      updated++;
    } else {
      // Lost from OSM — flag for human review.
      if (!f.properties.osm_removed) {
        f.properties.osm_removed = true;
        removed++;
      }
      merged.push(f);
    }
  }

  // Anything left in freshById is genuinely new.
  for (const f of freshById.values()) {
    merged.push(f);
    added++;
  }

  // Stable order: non-OSM first (preserving input order), then OSM sorted by id.
  const nonOsm = merged.filter((f) => !isOsmOnly(f));
  const osm = merged.filter(isOsmOnly).sort((a, b) =>
    a.properties.id.localeCompare(b.properties.id),
  );
  const sorted = [...nonOsm, ...osm];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ type: "FeatureCollection", features: sorted }, null, 2) + "\n",
    "utf8",
  );

  return { region: region.slug, added, updated, removed, kept_non_osm: keptNonOsm };
}

async function main(): Promise<void> {
  const wantSlug = process.argv[2];
  const regions = await loadRegions();
  const targets = wantSlug ? regions.filter((r) => r.slug === wantSlug) : regions;
  if (targets.length === 0) {
    console.error("No matching regions in regions.yml");
    process.exit(2);
  }
  const allStats: Stats[] = [];
  for (const region of targets) {
    console.error(`→ ${region.slug}: querying Overpass…`);
    const stats = await processRegion(region);
    console.error(`  +${stats.added} ~${stats.updated} -${stats.removed} (kept ${stats.kept_non_osm} non-OSM)`);
    allStats.push(stats);
  }
  process.stdout.write(JSON.stringify(allStats, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
