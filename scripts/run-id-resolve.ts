/**
 * External-ID resolver.
 *
 * Walks every non-vending feature in data/**.geojson and ensures it carries
 * the canonical Google + Apple Maps identifiers in its `sources[]`. Decoupled
 * from data enrichment (payment, amenities) so the ID-resolution pass can
 * finish quickly and downstream workflows can use the stored ids directly
 * instead of re-searching by name+coords each time.
 *
 * Sources of truth
 *   - Google: gosom/google-maps-scraper, same docker invocation pattern as
 *     run-gmaps-payment.ts. We just throw away the about/payment fields and
 *     keep `place_id` (preferred) or `cid` (fallback).
 *   - Apple: DuckDuckGo's `local.js` endpoint. Returns JSON with
 *     `provider_meta.apple.place_id` for each result. Free, ~500 ms/query,
 *     no Apple Developer account required. We fetch a fresh `vqd` token
 *     from the maps homepage once per script run.
 *
 * Selection
 *   - Each feature is considered for two independent slots: gmaps + apple.
 *   - Skip a slot if the feature already has a real id for it (a `sources[]`
 *     entry whose id is not a known placeholder like "payment").
 *   - Skip a slot if `gmaps_id_attempted` / `apple_id_attempted` is within
 *     the last ATTEMPTED_TTL_DAYS (same negative-cache pattern as
 *     run-gmaps-payment.ts).
 *   - Filter to features with `name.length >= MIN_NAME_LENGTH`. Single-word
 *     generic names like "Kiosk" can't be disambiguated reliably.
 *
 * Durability
 *   - Flush each modified file after every iteration.
 *   - Trap SIGTERM so a runner-side timeout exits cleanly with partial
 *     progress preserved.
 *   - --max-runtime-min bounds wall-clock so the workflow's wrap-up steps
 *     still run before the job hits its hard ceiling.
 *
 * Usage
 *   bun scripts/run-id-resolve.ts [--batch N] [--region <slug>]
 *                                 [--max-runtime-min N] [--only gmaps|apple]
 *                                 [--dry-run]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const TMP_DIR = join(REPO_ROOT, ".tmp/id-resolve");
const SCRAPER_IMAGE = "gosom/google-maps-scraper";
const GMAPS_CONFIRM_RADIUS_M = 50;
const GMAPS_SEARCH_RADIUS_M = 300;
const GOSOM_TIMEOUT_S = 60;
const APPLE_CONFIRM_RADIUS_M = 150;
const GMAPS_SLEEP_MS = 2000;
const APPLE_SLEEP_MS = 1000;
const MIN_NAME_LENGTH = 3;
const DEFAULT_BATCH = 100;
const DEFAULT_MAX_RUNTIME_MIN = 300;
const ATTEMPTED_TTL_DAYS = 30;
// Placeholder ids historically written by run-gmaps-payment.ts before the
// real-id change landed. Treat as missing so this resolver upgrades them.
const PLACEHOLDER_IDS = new Set(["payment", "gmaps"]);

// ── types ──────────────────────────────────────────────────────────────────

interface Source {
  type: string;
  id: string;
  version?: number;
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name?: string;
    sources?: Source[];
    updated?: string;
    kind?: string;
    gmaps_id_attempted?: string;
    apple_id_attempted?: string;
    [k: string]: unknown;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

interface GmapsEntry {
  title?: string;
  latitude?: number;
  longitude?: number;
  longtitude?: number; // gosom typo
  place_id?: string;
  cid?: string;
  data_id?: string;
}

interface DDGLocalResult {
  name?: string;
  coordinates?: { latitude?: number; longitude?: number };
  provider_meta?: { apple?: { place_id?: string } };
}

interface DDGLocalResponse {
  results?: DDGLocalResult[];
}

interface Stats {
  considered: number;
  skipped_recent_attempt: number;
  needs_gmaps: number;
  needs_apple: number;
  gmaps_resolved: number;
  apple_resolved: number;
  gmaps_no_match: number;
  apple_no_match: number;
  gmaps_errored: number;
  apple_errored: number;
  stopped_reason?: "sigterm" | "max_runtime" | "batch_done";
}

type SlotKind = "gmaps" | "apple";

// ── arg parsing ────────────────────────────────────────────────────────────

function args(): {
  batch: number;
  region: string | null;
  only: SlotKind | null;
  maxRuntimeMin: number;
  dryRun: boolean;
} {
  const a = process.argv.slice(2);
  const grab = (flag: string): string | null => {
    const ix = a.indexOf(flag);
    return ix >= 0 ? (a[ix + 1] ?? null) : null;
  };
  const batch = parseInt(grab("--batch") ?? "", 10);
  const maxRuntime = parseInt(grab("--max-runtime-min") ?? "", 10);
  const onlyRaw = grab("--only");
  const only =
    onlyRaw === "gmaps" || onlyRaw === "apple" ? (onlyRaw as SlotKind) : null;
  return {
    batch: Number.isFinite(batch) ? batch : DEFAULT_BATCH,
    region: grab("--region"),
    only,
    maxRuntimeMin: Number.isFinite(maxRuntime) ? maxRuntime : DEFAULT_MAX_RUNTIME_MIN,
    dryRun: a.includes("--dry-run"),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function daysSince(iso: string | undefined, today: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (today.getTime() - t) / 86_400_000;
}

function isDockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
  return r.status === 0;
}

async function findGeojsonFiles(): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const p = join(dir, entry);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else if (entry.endsWith(".geojson")) out.push(p);
    }
  }
  await walk(join(REPO_ROOT, "data"));
  return out;
}

function hasRealId(sources: Source[] | undefined, slot: SlotKind): boolean {
  const entry = sources?.find((s) => s.type === slot);
  return !!entry && !PLACEHOLDER_IDS.has(entry.id);
}

function upsertSource(feature: Feature, slot: SlotKind, id: string): void {
  const sources = feature.properties.sources ?? [];
  const existing = sources.find((s) => s.type === slot);
  if (existing) existing.id = id;
  else sources.push({ type: slot, id });
  feature.properties.sources = sources;
}

// ── gosom (Google) ─────────────────────────────────────────────────────────

async function queryGmaps(name: string, lat: number, lng: number): Promise<GmapsEntry[]> {
  mkdirSync(TMP_DIR, { recursive: true });
  const inputPath = join(TMP_DIR, "in.txt");
  const outputPath = join(TMP_DIR, "out.json");
  await writeFile(inputPath, `${name}\n`, "utf8");
  await rm(outputPath, { force: true });

  const dockerArgs = [
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
    "-exit-on-inactivity", `${GOSOM_TIMEOUT_S}s`,
  ];
  execFileSync("docker", dockerArgs, { stdio: ["ignore", "ignore", "pipe"] });

  const buf = await readFile(outputPath, "utf8").catch(() => "");
  if (!buf.trim()) return [];
  try {
    const arr = JSON.parse(buf);
    if (Array.isArray(arr)) return arr as GmapsEntry[];
    return [arr as GmapsEntry];
  } catch {
    const out: GmapsEntry[] = [];
    for (const line of buf.split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as GmapsEntry);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

function gmapsLng(r: GmapsEntry): number | undefined {
  return typeof r.longitude === "number" ? r.longitude : r.longtitude;
}

function matchGmaps(results: GmapsEntry[], lat: number, lng: number): GmapsEntry | null {
  for (const r of results) {
    const rLng = gmapsLng(r);
    if (typeof r.latitude !== "number" || typeof rLng !== "number") continue;
    if (haversineMeters(lat, lng, r.latitude, rLng) <= GMAPS_CONFIRM_RADIUS_M) return r;
  }
  return null;
}

// ── DuckDuckGo (Apple Maps) ───────────────────────────────────────────────

let cachedVqd: string | null = null;

/** Fetch DDG's session vqd token from the maps homepage. The token is a
 *  CSRF-style marker the local.js endpoint expects. Cached for the lifetime
 *  of the script — DDG rotates it but the cadence is forgiving. */
async function getVqd(query: string): Promise<string | null> {
  if (cachedVqd) return cachedVqd;
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iar=maps`;
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
    },
  });
  if (!resp.ok) return null;
  const html = await resp.text();
  const m = html.match(/vqd=["']?(\d-\d+(?:-\d+)?)/);
  cachedVqd = m?.[1] ?? null;
  return cachedVqd;
}

async function queryApple(name: string, lat: number, lng: number): Promise<DDGLocalResult[]> {
  const vqd = await getVqd(`${name}`);
  const url = new URL("https://duckduckgo.com/local.js");
  url.searchParams.set("tg", "maps_places");
  url.searchParams.set("rt", "D");
  url.searchParams.set("mkexp", "b");
  url.searchParams.set("wiki_info", "1");
  url.searchParams.set("q", name);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  if (vqd) url.searchParams.set("vqd", vqd);

  const resp = await fetch(url.toString(), {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "accept": "application/json, text/plain, */*",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      "referer": "https://duckduckgo.com/",
    },
  });
  if (!resp.ok) throw new Error(`ddg local.js ${resp.status}`);
  const json = (await resp.json()) as DDGLocalResponse;
  return json.results ?? [];
}

function matchApple(
  results: DDGLocalResult[],
  lat: number,
  lng: number,
): DDGLocalResult | null {
  let best: { r: DDGLocalResult; meters: number } | null = null;
  for (const r of results) {
    const rLat = r.coordinates?.latitude;
    const rLng = r.coordinates?.longitude;
    const id = r.provider_meta?.apple?.place_id;
    if (typeof rLat !== "number" || typeof rLng !== "number" || !id) continue;
    const meters = haversineMeters(lat, lng, rLat, rLng);
    if (meters > APPLE_CONFIRM_RADIUS_M) continue;
    if (!best || meters < best.meters) best = { r, meters };
  }
  return best?.r ?? null;
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batch, region, only, maxRuntimeMin, dryRun } = args();
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today);
  const startedAt = Date.now();
  const maxRuntimeMs = maxRuntimeMin * 60_000;

  const needGmaps = only === null || only === "gmaps";
  const needApple = only === null || only === "apple";

  if (needGmaps && !isDockerAvailable() && !dryRun) {
    process.stdout.write(
      JSON.stringify({ skipped: "docker unavailable for gmaps slot", batch, region }, null, 2) + "\n",
    );
    return;
  }

  const files = await findGeojsonFiles();
  const candidates: Array<{
    file: string;
    index: number;
    feature: Feature;
    wantGmaps: boolean;
    wantApple: boolean;
  }> = [];
  let skippedRecentAttempt = 0;

  for (const file of files) {
    if (region && !file.endsWith(`/${region}.geojson`)) continue;
    const doc = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
    for (let i = 0; i < doc.features.length; i++) {
      const f = doc.features[i]!;
      if (f.properties.kind === "vending_machine") continue;
      if (!f.properties.name || f.properties.name.length < MIN_NAME_LENGTH) continue;

      const wantGmaps =
        needGmaps &&
        !hasRealId(f.properties.sources, "gmaps") &&
        daysSince(f.properties.gmaps_id_attempted, todayDate) >= ATTEMPTED_TTL_DAYS;
      const wantApple =
        needApple &&
        !hasRealId(f.properties.sources, "apple") &&
        daysSince(f.properties.apple_id_attempted, todayDate) >= ATTEMPTED_TTL_DAYS;

      if (!wantGmaps && !wantApple) {
        if (
          (needGmaps && !hasRealId(f.properties.sources, "gmaps")) ||
          (needApple && !hasRealId(f.properties.sources, "apple"))
        ) {
          skippedRecentAttempt++;
        }
        continue;
      }
      candidates.push({ file, index: i, feature: f, wantGmaps, wantApple });
    }
  }

  const considered = candidates.length;
  const todo = candidates.slice(0, batch);

  const stats: Stats = {
    considered,
    skipped_recent_attempt: skippedRecentAttempt,
    needs_gmaps: todo.filter((c) => c.wantGmaps).length,
    needs_apple: todo.filter((c) => c.wantApple).length,
    gmaps_resolved: 0,
    apple_resolved: 0,
    gmaps_no_match: 0,
    apple_no_match: 0,
    gmaps_errored: 0,
    apple_errored: 0,
  };

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ...stats,
          would_query: todo.length,
          sample: todo.slice(0, 5).map((c) => ({
            id: c.feature.properties.id,
            name: c.feature.properties.name,
            wantGmaps: c.wantGmaps,
            wantApple: c.wantApple,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (needGmaps) {
    console.error(`Pulling ${SCRAPER_IMAGE}…`);
    spawnSync("docker", ["pull", SCRAPER_IMAGE], { stdio: ["ignore", "ignore", "inherit"] });
  }

  let stopRequested: Stats["stopped_reason"] | null = null;
  const requestStop = (reason: NonNullable<Stats["stopped_reason"]>): void => {
    if (!stopRequested) {
      stopRequested = reason;
      console.error(`stop requested: ${reason}`);
    }
  };
  process.on("SIGTERM", () => requestStop("sigterm"));
  process.on("SIGINT", () => requestStop("sigterm"));

  const fileDocs = new Map<string, FeatureCollection>();
  const dirty = new Set<string>();
  async function ensureDoc(file: string): Promise<FeatureCollection> {
    let doc = fileDocs.get(file);
    if (!doc) {
      doc = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
      fileDocs.set(file, doc);
    }
    return doc;
  }
  async function flushDirty(): Promise<void> {
    for (const file of dirty) {
      const doc = fileDocs.get(file);
      if (!doc) continue;
      await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
    }
    dirty.clear();
  }

  for (let i = 0; i < todo.length; i++) {
    if (stopRequested) break;
    if (Date.now() - startedAt >= maxRuntimeMs) {
      requestStop("max_runtime");
      break;
    }

    const c = todo[i]!;
    const name = c.feature.properties.name ?? "";
    const [lng, lat] = c.feature.geometry.coordinates;
    console.error(
      `[${i + 1}/${todo.length}] ${c.feature.properties.id} "${name}" | gmaps=${c.wantGmaps} apple=${c.wantApple}`,
    );

    const doc = await ensureDoc(c.file);
    const feature = doc.features[c.index]!;

    // Apple first — cheaper, less likely to be rate-limited per minute.
    if (c.wantApple) {
      try {
        const results = await queryApple(name, lat, lng);
        const match = matchApple(results, lat, lng);
        const placeId = match?.provider_meta?.apple?.place_id;
        if (placeId) {
          upsertSource(feature, "apple", placeId);
          delete feature.properties.apple_id_attempted;
          stats.apple_resolved++;
          console.error(`  +apple: ${placeId}`);
        } else {
          feature.properties.apple_id_attempted = today;
          stats.apple_no_match++;
        }
      } catch (err) {
        console.error(`  apple error: ${(err as Error).message}`);
        feature.properties.apple_id_attempted = today;
        stats.apple_errored++;
      }
      dirty.add(c.file);
      await flushDirty();
      await new Promise((r) => setTimeout(r, APPLE_SLEEP_MS));
      if (stopRequested) break;
      if (Date.now() - startedAt >= maxRuntimeMs) {
        requestStop("max_runtime");
        break;
      }
    }

    if (c.wantGmaps) {
      try {
        const results = await queryGmaps(name, lat, lng);
        const match = matchGmaps(results, lat, lng);
        const id = match?.place_id || match?.cid;
        if (id) {
          upsertSource(feature, "gmaps", id);
          delete feature.properties.gmaps_id_attempted;
          stats.gmaps_resolved++;
          console.error(`  +gmaps: ${id}`);
        } else {
          feature.properties.gmaps_id_attempted = today;
          stats.gmaps_no_match++;
        }
      } catch (err) {
        console.error(`  gmaps error: ${(err as Error).message}`);
        feature.properties.gmaps_id_attempted = today;
        stats.gmaps_errored++;
      }
      dirty.add(c.file);
      await flushDirty();
      await new Promise((r) => setTimeout(r, GMAPS_SLEEP_MS));
    }
  }

  await flushDirty();
  stats.stopped_reason = stopRequested ?? "batch_done";
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
