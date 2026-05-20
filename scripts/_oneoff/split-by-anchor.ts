/**
 * One-shot: split the misnamed `data/de/hessen/frankfurt.geojson`
 * (everything-everywhere from the hopfenstop seed) into per-metro region
 * files keyed by the closest anchor city.
 *
 * Algorithm:
 *   for each feature
 *     pick the anchor minimizing haversine distance
 *     if distance > MAX_RADIUS_KM → drop (likely bad coord)
 *     otherwise → append to that anchor's output file
 *
 * Run once, commit the diff, then delete this script (or keep archived).
 *
 * After running: update regions.yml to declare the new regions so the
 * weekly osm-scrape workflow + monthly enrich workflow can target them.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SOURCE = resolve(REPO_ROOT, "data/de/hessen/frankfurt.geojson");
const MAX_RADIUS_KM = 60; // beyond this from any anchor → drop

interface Anchor {
  slug: string;
  path: string;          // relative to repo root
  prefix: string;        // ID prefix
  lat: number;
  lng: number;
  // For regions.yml (filled in later, not used here)
  iso3166_2: string;
  admin_level: number;
}

// Anchor list ordered roughly by expected feature count.
const ANCHORS: Anchor[] = [
  { slug: "frankfurt",      path: "data/de/hessen/frankfurt.geojson",                  prefix: "fr",  lat: 50.1109, lng: 8.6821,  iso3166_2: "DE-HE", admin_level: 6 },
  { slug: "ruhr",           path: "data/de/nordrhein-westfalen/ruhr.geojson",          prefix: "ru",  lat: 51.4818, lng: 7.2162,  iso3166_2: "DE-NW", admin_level: 6 },
  { slug: "koeln",          path: "data/de/nordrhein-westfalen/koeln.geojson",         prefix: "k",   lat: 50.9375, lng: 6.9603,  iso3166_2: "DE-NW", admin_level: 6 },
  { slug: "duesseldorf",    path: "data/de/nordrhein-westfalen/duesseldorf.geojson",   prefix: "d",   lat: 51.2277, lng: 6.7735,  iso3166_2: "DE-NW", admin_level: 6 },
  { slug: "berlin",         path: "data/de/berlin/berlin.geojson",                     prefix: "b",   lat: 52.5200, lng: 13.4050, iso3166_2: "DE-BE", admin_level: 4 },
  { slug: "hamburg",        path: "data/de/hamburg/hamburg.geojson",                   prefix: "hh",  lat: 53.5511, lng: 9.9937,  iso3166_2: "DE-HH", admin_level: 4 },
  { slug: "muenchen",       path: "data/de/bayern/muenchen.geojson",                   prefix: "m",   lat: 48.1351, lng: 11.5820, iso3166_2: "DE-BY", admin_level: 6 },
  { slug: "stuttgart",      path: "data/de/baden-wuerttemberg/stuttgart.geojson",      prefix: "s",   lat: 48.7758, lng: 9.1829,  iso3166_2: "DE-BW", admin_level: 6 },
  { slug: "hannover",       path: "data/de/niedersachsen/hannover.geojson",            prefix: "h",   lat: 52.3759, lng: 9.7320,  iso3166_2: "DE-NI", admin_level: 6 },
  { slug: "leipzig",        path: "data/de/sachsen/leipzig.geojson",                   prefix: "l",   lat: 51.3397, lng: 12.3731, iso3166_2: "DE-SN", admin_level: 6 },
  { slug: "halle",          path: "data/de/sachsen-anhalt/halle.geojson",              prefix: "hal", lat: 51.4825, lng: 11.9700, iso3166_2: "DE-ST", admin_level: 6 },
  { slug: "freiburg",       path: "data/de/baden-wuerttemberg/freiburg.geojson",       prefix: "fr-bw", lat: 47.9990, lng: 7.8421, iso3166_2: "DE-BW", admin_level: 6 },
  { slug: "mannheim",       path: "data/de/baden-wuerttemberg/mannheim.geojson",       prefix: "ma",  lat: 49.4875, lng: 8.4660,  iso3166_2: "DE-BW", admin_level: 6 },
  { slug: "bremen",         path: "data/de/bremen/bremen.geojson",                     prefix: "hb",  lat: 53.0793, lng: 8.8017,  iso3166_2: "DE-HB", admin_level: 4 },
];

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; [k: string]: unknown };
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371.0088;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const l1 = (aLat * Math.PI) / 180;
  const l2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(l1) * Math.cos(l2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function main(): Promise<void> {
  const src = JSON.parse(await readFile(SOURCE, "utf8")) as { type: string; features: Feature[] };
  const buckets = new Map<string, Feature[]>();
  for (const a of ANCHORS) buckets.set(a.slug, []);
  const dropped: Array<{ id: string; reason: string; dist?: number }> = [];

  for (const f of src.features) {
    const [lng, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      dropped.push({ id: f.properties.id, reason: "invalid coords" });
      continue;
    }
    let best: { anchor: Anchor; dist: number } | null = null;
    for (const a of ANCHORS) {
      const d = haversineKm(a.lat, a.lng, lat, lng);
      if (!best || d < best.dist) best = { anchor: a, dist: d };
    }
    if (!best) continue;
    if (best.dist > MAX_RADIUS_KM) {
      dropped.push({ id: f.properties.id, reason: "no anchor within radius", dist: best.dist });
      continue;
    }
    buckets.get(best.anchor.slug)!.push(f);
  }

  // Write each non-empty bucket.
  let totalWritten = 0;
  for (const a of ANCHORS) {
    const feats = buckets.get(a.slug)!;
    if (feats.length === 0) {
      console.log(`${a.slug}: 0 features (skipping)`);
      continue;
    }
    feats.sort((x, y) => x.properties.id.localeCompare(y.properties.id));
    const targetPath = resolve(REPO_ROOT, a.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      JSON.stringify({ type: "FeatureCollection", features: feats }, null, 2) + "\n",
      "utf8",
    );
    console.log(`${a.slug}: ${feats.length} features → ${a.path}`);
    totalWritten += feats.length;
  }

  // Drop the old source if it ended up in a non-Frankfurt bucket (i.e. its
  // path is no longer one of the targets). Here Frankfurt RE-uses the same
  // path, so the file gets overwritten and no removal is needed.

  console.log(`\nTotal written: ${totalWritten}/${src.features.length}`);
  console.log(`Dropped: ${dropped.length} features`);
  if (dropped.length > 0) {
    const sample = dropped.slice(0, 10);
    console.log("First 10 dropped:");
    for (const d of sample) {
      console.log(`  ${d.id}: ${d.reason}${d.dist ? ` (closest anchor ${d.dist.toFixed(0)} km away)` : ""}`);
    }
  }

  // Emit a regions.yml snippet for copy-paste.
  console.log("\n--- regions.yml entries (paste into regions: section) ---");
  for (const a of ANCHORS) {
    if (buckets.get(a.slug)!.length === 0) continue;
    // Tight bbox: smallest box containing all features in the bucket, padded.
    const feats = buckets.get(a.slug)!;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const f of feats) {
      const [lng, lat] = f.geometry.coordinates;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    const pad = 0.02;
    console.log(`  - slug: ${a.slug}`);
    console.log(`    path: ${a.path}`);
    console.log(`    prefix: ${a.prefix}`);
    console.log(`    iso3166_2: ${a.iso3166_2}`);
    console.log(`    admin_level: ${a.admin_level}`);
    console.log(`    bbox: [${(w - pad).toFixed(2)}, ${(s - pad).toFixed(2)}, ${(e + pad).toFixed(2)}, ${(n + pad).toFixed(2)}]`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
