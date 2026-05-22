/**
 * Apple Maps place-id resolver.
 *
 * For every non-vending feature that doesn't yet have an
 * `{type:"apple", id}` entry in `sources[]`, query DuckDuckGo's
 * `local.js` endpoint by name + coords and stamp
 * `provider_meta.apple.place_id` from the closest match.
 *
 * Why DDG and not the Apple Developer Search API: DDG is free, no
 * account, ~500 ms per query. The MapKit JWT-based Search API would be
 * faster and more accurate but costs $99/yr.
 *
 * Why Apple-only: Google place_ids already arrive as a side effect of
 * `run-gmaps-payment.ts` (since it stores the matched place_id in
 * `sources[]`). Running gosom from this script too just duplicates that
 * work at ~30× the latency.
 *
 * Selection
 *   - Skip features that already have a real `{type:"apple", id}`.
 *   - Skip features whose `apple_id_attempted` is within the last
 *     ATTEMPTED_TTL_DAYS (negative cache so DDG misses don't get
 *     re-queried daily).
 *   - Require `name.length >= MIN_NAME_LENGTH` — single-word generic
 *     names ("Kiosk") never disambiguate.
 *
 * Durability
 *   - Each modified file is flushed to disk after every iteration.
 *   - SIGTERM trap exits cleanly on runner-cancel so partial progress
 *     reaches a PR.
 *   - --max-runtime-min bounds wall-clock with headroom under the
 *     workflow's job-timeout.
 *
 * Usage
 *   bun scripts/run-id-resolve.ts [--batch N] [--region <slug>]
 *                                 [--max-runtime-min N] [--dry-run]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const APPLE_CONFIRM_RADIUS_M = 150;
const APPLE_SLEEP_MS = 1000;
const MIN_NAME_LENGTH = 3;
const DEFAULT_BATCH = 100;
const DEFAULT_MAX_RUNTIME_MIN = 300;
const ATTEMPTED_TTL_DAYS = 30;

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
    apple_id_attempted?: string;
    [k: string]: unknown;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
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
  queried: number;
  resolved: number;
  no_match: number;
  errored: number;
  stopped_reason?: "sigterm" | "max_runtime" | "batch_done";
}

// ── arg parsing ────────────────────────────────────────────────────────────

function args(): {
  batch: number;
  region: string | null;
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
  return {
    batch: Number.isFinite(batch) ? batch : DEFAULT_BATCH,
    region: grab("--region"),
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

function hasAppleId(sources: Source[] | undefined): boolean {
  return !!sources?.find((s) => s.type === "apple" && s.id);
}

function upsertAppleSource(feature: Feature, id: string): void {
  const sources = feature.properties.sources ?? [];
  const existing = sources.find((s) => s.type === "apple");
  if (existing) existing.id = id;
  else sources.push({ type: "apple", id });
  feature.properties.sources = sources;
}

// ── DuckDuckGo (Apple Maps) ───────────────────────────────────────────────

let cachedVqd: string | null = null;

/** DDG's session vqd token. Fetched once from the maps homepage; cached for
 *  the lifetime of the script. The local.js endpoint accepts the call even
 *  without vqd in many cases, but supplying one keeps us on the well-trodden
 *  path of how the actual browser client uses the API. */
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
  const vqd = await getVqd(name);
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
      accept: "application/json, text/plain, */*",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      referer: "https://duckduckgo.com/",
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
  const { batch, region, maxRuntimeMin, dryRun } = args();
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today);
  const startedAt = Date.now();
  const maxRuntimeMs = maxRuntimeMin * 60_000;

  const files = await findGeojsonFiles();
  const candidates: Array<{ file: string; index: number; feature: Feature }> = [];
  let skippedRecentAttempt = 0;

  for (const file of files) {
    if (region && !file.endsWith(`/${region}.geojson`)) continue;
    const doc = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
    for (let i = 0; i < doc.features.length; i++) {
      const f = doc.features[i]!;
      if (f.properties.kind === "vending_machine") continue;
      if (!f.properties.name || f.properties.name.length < MIN_NAME_LENGTH) continue;
      if (hasAppleId(f.properties.sources)) continue;
      if (daysSince(f.properties.apple_id_attempted, todayDate) < ATTEMPTED_TTL_DAYS) {
        skippedRecentAttempt++;
        continue;
      }
      candidates.push({ file, index: i, feature: f });
    }
  }

  const considered = candidates.length;
  const todo = candidates.slice(0, batch);

  const stats: Stats = {
    considered,
    skipped_recent_attempt: skippedRecentAttempt,
    queried: 0,
    resolved: 0,
    no_match: 0,
    errored: 0,
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
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // GH sends SIGTERM ~5 min before the job-timeout SIGKILL. Set the flag
  // and break out at the next iteration boundary; the dirty files have
  // already been flushed per-iteration so partial progress survives.
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
    console.error(`[${i + 1}/${todo.length}] ${c.feature.properties.id} "${name}" …`);

    const doc = await ensureDoc(c.file);
    const feature = doc.features[c.index]!;

    stats.queried++;
    try {
      const results = await queryApple(name, lat, lng);
      const match = matchApple(results, lat, lng);
      const placeId = match?.provider_meta?.apple?.place_id;
      if (placeId) {
        upsertAppleSource(feature, placeId);
        delete feature.properties.apple_id_attempted;
        stats.resolved++;
        console.error(`  +apple: ${placeId}`);
      } else {
        feature.properties.apple_id_attempted = today;
        stats.no_match++;
      }
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`);
      feature.properties.apple_id_attempted = today;
      stats.errored++;
    }
    dirty.add(c.file);
    await flushDirty();
    await new Promise((r) => setTimeout(r, APPLE_SLEEP_MS));
  }

  await flushDirty();
  stats.stopped_reason = stopRequested ?? "batch_done";
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
