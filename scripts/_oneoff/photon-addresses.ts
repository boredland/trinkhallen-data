/**
 * Backfill missing addresses via Photon (https://photon.komoot.io/), an
 * OSM-backed reverse-geocoder. Free, no API key, but please throttle —
 * 1 request per second is the documented courtesy limit on the public
 * instance.
 *
 * Targets features that have *some* missing address part (street OR
 * housenumber). The merge is conservative: we only fill blanks, never
 * overwrite an existing value. We also reject hits further than 50m from
 * the kiosk point — beyond that we'd risk grabbing an address from the
 * other side of the street or a neighbouring building.
 *
 * Usage:
 *   bun scripts/_oneoff/photon-addresses.ts --source hopfenstop --dry-run
 *   bun scripts/_oneoff/photon-addresses.ts --source osm
 *   bun scripts/_oneoff/photon-addresses.ts --source any --region frankfurt --max 100
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Source {
  type: string;
  id?: string;
}

interface Feature {
  geometry: { coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    address?: Record<string, string>;
    sources?: Source[];
    updated?: string;
    [k: string]: unknown;
  };
}

interface Doc {
  type: "FeatureCollection";
  features: Feature[];
}

interface PhotonProps {
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  district?: string;
  country?: string;
  state?: string;
  type?: string;
  name?: string;
}

interface PhotonResp {
  features: Array<{
    geometry: { coordinates: [number, number] };
    properties: PhotonProps;
  }>;
}

// CLI ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const ix = argv.indexOf(name);
  return ix >= 0 ? argv[ix + 1] : fallback;
}
const SOURCE = (arg("--source", "hopfenstop") ?? "hopfenstop") as "hopfenstop" | "osm" | "any";
const REGION_FILTER = arg("--region");
const MAX_RAW = arg("--max");
const MAX = MAX_RAW ? Number.parseInt(MAX_RAW, 10) : Number.POSITIVE_INFINITY;
const DRY_RUN = argv.includes("--dry-run");

const PHOTON_BASE = "https://photon.komoot.io";
const PHOTON_DELAY_MS = 1100; // ~1 req/s, mild buffer
const MAX_DISTANCE_M = 50;

// File discovery ─────────────────────────────────────────────────────────────
function findFiles(): string[] {
  const out = execSync(`find data -name '*.geojson' | sort`, { encoding: "utf8" });
  const all = out.trim().split("\n").filter(Boolean);
  if (!REGION_FILTER) return all;
  return all.filter((p) => p.endsWith(`/${REGION_FILTER}.geojson`));
}

function hasSrc(f: Feature, t: string): boolean {
  return f.properties.sources?.some((s) => s.type === t) ?? false;
}

function needsAddress(f: Feature): boolean {
  const a = f.properties.address ?? {};
  return !a["street"] || !a["number"];
}

function shouldEnrich(f: Feature): boolean {
  if (!needsAddress(f)) return false;
  if (SOURCE === "any") return true;
  return hasSrc(f, SOURCE);
}

function dist(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLng = r(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function photonReverse(lat: number, lng: number): Promise<PhotonProps | null> {
  const url = `${PHOTON_BASE}/reverse?lat=${lat}&lon=${lng}&lang=de&radius=0.05&limit=5`;
  const resp = await fetch(url, {
    headers: { "user-agent": "trinkhallen-data/photon-addresses (https://trinkhallen.app)" },
  });
  if (!resp.ok) {
    console.error(`  photon HTTP ${resp.status}`);
    return null;
  }
  const data = (await resp.json()) as PhotonResp;
  if (!data.features?.length) return null;

  // Rank hits by usefulness (street + number > number-only > street-only),
  // then by distance, capped at MAX_DISTANCE_M. Both "Germany" and
  // "Deutschland" pass — Photon localises the country name on lang=de.
  let best: { props: PhotonProps; meters: number; score: number } | null = null;
  const okCountry = (c?: string) => !c || c === "Germany" || c === "Deutschland";
  for (const hit of data.features) {
    const p = hit.properties;
    if (!okCountry(p.country)) continue;
    const [hLng, hLat] = hit.geometry.coordinates;
    const m = dist(lat, lng, hLat, hLng);
    if (m > MAX_DISTANCE_M) continue;
    // Useless hit if it carries neither street nor housenumber.
    if (!p.street && !p.housenumber) continue;
    const score = (p.street ? 2 : 0) + (p.housenumber ? 1 : 0);
    if (
      !best ||
      score > best.score ||
      (score === best.score && m < best.meters)
    ) {
      best = { props: p, meters: m, score };
    }
  }
  return best ? best.props : null;
}

interface Stats {
  considered: number;
  queried: number;
  matched: number;
  filled_street: number;
  filled_number: number;
  filled_postalcode: number;
  filled_city: number;
  filled_district: number;
  no_match: number;
  errored: number;
}

const stats: Stats = {
  considered: 0,
  queried: 0,
  matched: 0,
  filled_street: 0,
  filled_number: 0,
  filled_postalcode: 0,
  filled_city: 0,
  filled_district: 0,
  no_match: 0,
  errored: 0,
};

const today = new Date().toISOString().slice(0, 10);

async function processFile(path: string): Promise<{ touched: number }> {
  const doc = JSON.parse(readFileSync(path, "utf8")) as Doc;
  const candidates = doc.features.filter(shouldEnrich);
  if (candidates.length === 0) return { touched: 0 };

  let touched = 0;
  for (const f of candidates) {
    if (stats.queried >= MAX) break;
    stats.considered++;
    const [lng, lat] = f.geometry.coordinates;

    let hit: PhotonProps | null = null;
    try {
      hit = await photonReverse(lat, lng);
      stats.queried++;
    } catch (err) {
      console.error(`  [${f.properties.id}] photon error: ${(err as Error).message}`);
      stats.errored++;
      continue;
    } finally {
      await new Promise((r) => setTimeout(r, PHOTON_DELAY_MS));
    }

    if (!hit) {
      stats.no_match++;
      console.error(`  [${f.properties.id}] no match`);
      continue;
    }
    stats.matched++;

    const a = f.properties.address ?? {};
    const next: Record<string, string> = { ...a };
    let changed = false;
    if (!next["street"] && hit.street) {
      next["street"] = hit.street;
      stats.filled_street++;
      changed = true;
    }
    if (!next["number"] && hit.housenumber) {
      next["number"] = hit.housenumber;
      stats.filled_number++;
      changed = true;
    }
    if (!next["postalcode"] && hit.postcode) {
      next["postalcode"] = hit.postcode;
      stats.filled_postalcode++;
      changed = true;
    }
    if (!next["city"] && hit.city) {
      next["city"] = hit.city;
      stats.filled_city++;
      changed = true;
    }
    if (!next["district"] && hit.district) {
      next["district"] = hit.district;
      stats.filled_district++;
      changed = true;
    }
    if (changed) {
      f.properties.address = next;
      f.properties.updated = today;
      touched++;
      console.error(
        `  [${f.properties.id}] +addr ${[hit.street, hit.housenumber].filter(Boolean).join(" ")}`,
      );
    }
  }

  if (!DRY_RUN && touched > 0) {
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
  return { touched };
}

const files = findFiles();
console.error(
  `photon-addresses: source=${SOURCE} region=${REGION_FILTER ?? "all"} max=${MAX === Number.POSITIVE_INFINITY ? "∞" : MAX} dry-run=${DRY_RUN}`,
);
console.error(`files: ${files.length}`);

let totalTouched = 0;
for (const f of files) {
  if (stats.queried >= MAX) break;
  const region = f.replace(/^data\/de\//, "").replace(/\.geojson$/, "");
  console.error(`\n=== ${region} ===`);
  const { touched } = await processFile(f);
  totalTouched += touched;
  console.error(`  touched: ${touched}`);
}

process.stdout.write(JSON.stringify({ ...stats, files_touched_total: totalTouched, dry_run: DRY_RUN }, null, 2) + "\n");
