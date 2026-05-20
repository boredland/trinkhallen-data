/**
 * Confirm uncertain enrichment matches by checking Google Maps via the
 * `gosom/google-maps-scraper` Docker image.
 *
 * For each row in `_enrichment-uncertain.csv`:
 *   1. Build a one-line gosom input file containing the OSM name.
 *   2. Run gosom geo-biased at the feature's coords with a 300 m radius.
 *   3. Parse the JSON results.
 *   4. If any result lands within 50 m of the feature → CONFIRMED.
 *      Update the feature in its region geojson (add OSM source, dates),
 *      drop the row from the uncertain CSV.
 *   5. Otherwise leave the row in the CSV for human review.
 *
 * Designed to run after `enrich-from-osm.ts` in the workflow. Skips itself
 * cleanly when there's no uncertain CSV (no rows to confirm) or when the
 * docker image isn't available (e.g. local dev without docker).
 *
 * ToS note: Google's Maps terms prohibit scraping. We accept that posture
 * deliberately for this low-volume monthly job (~tens of queries per month).
 * Detection risk at this rate is effectively zero; if Google ever blocks,
 * we just degrade gracefully — the script keeps the row in uncertain.csv.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const UNCERTAIN_PATH = join(REPO_ROOT, "_enrichment-uncertain.csv");
const TMP_DIR = join(REPO_ROOT, ".tmp/gmaps");
const GMAPS_CONFIRM_RADIUS_M = 50;     // gosom result must land within this of our feature
const GMAPS_SEARCH_RADIUS_M = 300;     // search radius to bias the query
const GMAPS_TIMEOUT_S = 60;            // -exit-on-inactivity ceiling per query
const SCRAPER_IMAGE = "gosom/google-maps-scraper";
const MIN_NAME_LENGTH = 3;             // skip queries shorter than this (too generic)

// ── types ───────────────────────────────────────────────────────────────────

interface UncertainRow {
  region: string;
  feature_id: string;
  feature_name: string;
  osm_ref: string;     // e.g. "node/1234567"
  osm_name: string;
  score: string;
  distance_m: string;
  name_sim: string;
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    sources?: Array<{ type: string; id: string; version?: number }>;
    updated?: string;
    [k: string]: unknown;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

interface GmapsResult {
  title?: string;
  latitude?: number;
  // gosom mis-spells longitude as "longtitude" in its JSON output; we accept
  // either so the script keeps working if they ever fix it upstream.
  longitude?: number;
  longtitude?: number;
}

function resultLng(r: GmapsResult): number | undefined {
  return typeof r.longitude === "number" ? r.longitude : r.longtitude;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === ",") { out.push(cur); cur = ""; }
      else if (ch === '"') inQuotes = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function quoteCsvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

async function loadUncertain(): Promise<UncertainRow[]> {
  if (!existsSync(UNCERTAIN_PATH)) return [];
  const lines = (await readFile(UNCERTAIN_PATH, "utf8")).split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((l) => {
    const cells = parseCsvRow(l);
    return {
      region:        cells[0] ?? "",
      feature_id:    cells[1] ?? "",
      feature_name:  cells[2] ?? "",
      osm_ref:       cells[3] ?? "",
      osm_name:      cells[4] ?? "",
      score:         cells[5] ?? "",
      distance_m:    cells[6] ?? "",
      name_sim:      cells[7] ?? "",
    };
  });
}

function isDockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
  return r.status === 0;
}

async function loadFeatureCollection(region: string): Promise<{ path: string; doc: FeatureCollection } | null> {
  // The uncertain CSV's "region" column is the slug (e.g. "frankfurt"). We
  // resolve it to the file via the regions.yml-style mapping that lives in
  // the seed file naming convention: data/de/<state>/<slug>.geojson.
  // Easiest: search the data tree for a file ending in /<slug>.geojson.
  const { readdir, stat } = await import("node:fs/promises");
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir)) {
      const p = join(dir, entry);
      const st = await stat(p);
      if (st.isDirectory()) out.push(...(await walk(p)));
      else if (entry === `${region}.geojson`) out.push(p);
    }
    return out;
  }
  const candidates = await walk(join(REPO_ROOT, "data"));
  if (candidates.length === 0) return null;
  const path = candidates[0]!;
  const doc = JSON.parse(await readFile(path, "utf8")) as FeatureCollection;
  return { path, doc };
}

function parseOsmRef(ref: string): { type: "node" | "way" | "relation"; id: string } | null {
  const m = ref.match(/^(node|way|relation)\/(\d+)$/);
  if (!m) return null;
  return { type: m[1] as "node" | "way" | "relation", id: m[2]! };
}

interface ConfirmAttempt {
  row: UncertainRow;
  feature: Feature | null;
  /** null = could not query, "confirmed" = matched, "no-match" = ran but no hit */
  result: "confirmed" | "no-match" | "skipped" | "error";
  detail?: string;
}

async function queryGmapsOnce(name: string, lat: number, lng: number): Promise<GmapsResult[]> {
  mkdirSync(TMP_DIR, { recursive: true });
  const inputPath = join(TMP_DIR, "in.txt");
  const outputPath = join(TMP_DIR, "out.json");
  await writeFile(inputPath, name + "\n", "utf8");
  // gosom runs in docker, often as root, so out.json ends up root-owned.
  // Re-opening it for write from the host as the runner user fails with EACCES;
  // unlink works because it only needs write perm on the parent dir.
  await rm(outputPath, { force: true });

  // Volume-mounted directory must be /work in the container.
  const args = [
    "run", "--rm",
    "-v", `${TMP_DIR}:/work`,
    "-v", "gmaps-playwright-cache:/opt",
    SCRAPER_IMAGE,
    "-input", "/work/in.txt",
    "-results", "/work/out.json",
    "-json",
    "-geo", `${lat},${lng}`,
    "-radius", String(GMAPS_SEARCH_RADIUS_M),
    "-zoom", "18",
    "-depth", "1",
    "-c", "1",
    "-exit-on-inactivity", `${GMAPS_TIMEOUT_S}s`,
  ];
  execFileSync("docker", args, { stdio: ["ignore", "ignore", "pipe"] });

  const buf = await readFile(outputPath, "utf8").catch(() => "");
  if (!buf.trim()) return [];
  // gosom JSON output is an array of objects, but for safety also accept NDJSON.
  try {
    const arr = JSON.parse(buf);
    if (Array.isArray(arr)) return arr as GmapsResult[];
    return [arr as GmapsResult];
  } catch {
    // NDJSON fallback
    const out: GmapsResult[] = [];
    for (const line of buf.split("\n").filter(Boolean)) {
      try { out.push(JSON.parse(line) as GmapsResult); } catch { /* skip */ }
    }
    return out;
  }
}

function confirm(results: GmapsResult[], lat: number, lng: number): boolean {
  for (const r of results) {
    const rLng = resultLng(r);
    if (typeof r.latitude !== "number" || typeof rLng !== "number") continue;
    if (haversineMeters(lat, lng, r.latitude, rLng) <= GMAPS_CONFIRM_RADIUS_M) {
      return true;
    }
  }
  return false;
}

function addOsmSource(f: Feature, ref: { type: string; id: string }): void {
  const sources = f.properties.sources ?? [];
  const refStr = `${ref.type}/${ref.id}`;
  if (sources.some((s) => s.type === "osm" && s.id === refStr)) return;
  sources.push({ type: "osm", id: refStr });
  f.properties.sources = sources;
  f.properties.updated = new Date().toISOString().slice(0, 10);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const uncertain = await loadUncertain();
  if (uncertain.length === 0) {
    process.stdout.write(JSON.stringify({ confirmed: 0, total: 0, reason: "no uncertain rows" }, null, 2) + "\n");
    return;
  }
  if (!isDockerAvailable()) {
    console.error("docker not available; skipping gmaps confirmation");
    process.stdout.write(JSON.stringify({ confirmed: 0, total: uncertain.length, reason: "docker unavailable" }, null, 2) + "\n");
    return;
  }

  console.error(`Pulling ${SCRAPER_IMAGE}…`);
  spawnSync("docker", ["pull", SCRAPER_IMAGE], { stdio: ["ignore", "ignore", "inherit"] });

  // Cache loaded geojson files so we touch each once.
  const fileCache = new Map<string, { path: string; doc: FeatureCollection }>();
  const attempts: ConfirmAttempt[] = [];
  const remaining: UncertainRow[] = [];

  for (let i = 0; i < uncertain.length; i++) {
    const row = uncertain[i]!;
    console.error(`[${i + 1}/${uncertain.length}] ${row.region}/${row.feature_id} "${row.osm_name}" …`);

    if (row.osm_name.trim().length < MIN_NAME_LENGTH) {
      attempts.push({ row, feature: null, result: "skipped", detail: "name too short" });
      remaining.push(row);
      continue;
    }

    let regionFile = fileCache.get(row.region);
    if (!regionFile) {
      const loaded = await loadFeatureCollection(row.region);
      if (!loaded) {
        attempts.push({ row, feature: null, result: "error", detail: "region file not found" });
        remaining.push(row);
        continue;
      }
      regionFile = loaded;
      fileCache.set(row.region, loaded);
    }

    const feature = regionFile.doc.features.find((f) => f.properties.id === row.feature_id) ?? null;
    if (!feature) {
      attempts.push({ row, feature: null, result: "error", detail: "feature not in region file" });
      remaining.push(row);
      continue;
    }

    const [lng, lat] = feature.geometry.coordinates;
    let results: GmapsResult[];
    try {
      results = await queryGmapsOnce(row.osm_name, lat, lng);
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`);
      attempts.push({ row, feature, result: "error", detail: (err as Error).message });
      remaining.push(row);
      continue;
    }

    if (confirm(results, lat, lng)) {
      console.error(`  confirmed (${results.length} result${results.length === 1 ? "" : "s"})`);
      const osmRef = parseOsmRef(row.osm_ref);
      if (!osmRef) {
        attempts.push({ row, feature, result: "error", detail: "malformed osm_ref" });
        remaining.push(row);
        continue;
      }
      addOsmSource(feature, osmRef);
      attempts.push({ row, feature, result: "confirmed" });
    } else {
      attempts.push({ row, feature, result: "no-match", detail: `${results.length} result(s), none within ${GMAPS_CONFIRM_RADIUS_M} m` });
      remaining.push(row);
    }
  }

  // Write back any region files we mutated.
  for (const { path, doc } of fileCache.values()) {
    await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }

  // Rewrite the uncertain CSV (or remove if empty).
  if (remaining.length === 0) {
    const { rm } = await import("node:fs/promises");
    await rm(UNCERTAIN_PATH).catch(() => { /* fine */ });
  } else {
    const header = "region,feature_id,feature_name,osm_ref,osm_name,score,distance_m,name_sim\n";
    const body = remaining
      .map((r) => [r.region, r.feature_id, r.feature_name, r.osm_ref, r.osm_name, r.score, r.distance_m, r.name_sim]
        .map(quoteCsvCell).join(","))
      .join("\n") + "\n";
    await writeFile(UNCERTAIN_PATH, header + body, "utf8");
  }

  const confirmed = attempts.filter((a) => a.result === "confirmed").length;
  const noMatch = attempts.filter((a) => a.result === "no-match").length;
  const skipped = attempts.filter((a) => a.result === "skipped").length;
  const errored = attempts.filter((a) => a.result === "error").length;
  process.stdout.write(
    JSON.stringify({ total: uncertain.length, confirmed, no_match: noMatch, skipped, errored, remaining: remaining.length }, null, 2) + "\n",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
