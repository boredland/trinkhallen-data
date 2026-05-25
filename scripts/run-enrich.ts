/**
 * Per-feature payment + hours enrichment, Apple-first with Google fallback.
 *
 * Pipeline per kiosk:
 *   1. Resolve Apple place_id via DuckDuckGo's `local.js` (if not already
 *      stored on `sources[]`). Stamp it as `{type:"apple",id}`.
 *   2. Fetch `maps.apple.com/place?auid=<id>` and extract the inlined
 *      `amenityV2` array + `businessHours` block. Map Apple Pay /
 *      Contactless to our `payment` tri-state; convert weekly hours to
 *      OSM `opening_hours` format. Conservative-merge into the feature.
 *   3. If payment is still incomplete OR hours are still missing, fall
 *      back to gosom (Google Maps scraper) — parse `About → Zahlungen`
 *      and the (often empty) `open_hours` block. Same conservative
 *      merge so nothing Apple wrote gets overwritten.
 *
 * Concurrency: per-provider p-queues throttle each upstream
 * independently. Six features may be in flight at once; each goes
 * through its three provider queues in sequence.
 *
 * Region scope: exactly one region per run. The daily cron picks one
 * at random; `workflow_dispatch` accepts a `region` input.
 *
 * Durability: each modified file is flushed after every iteration.
 * SIGTERM and `--max-runtime-min` both cause the in-flight features to
 * finish, no new work to start, and a final flush + stats write — so
 * the workflow's diff + PR steps still see whatever progress landed.
 *
 * Usage
 *   bun scripts/run-enrich.ts --region <slug>
 *                             [--batch N] [--max-runtime-min N] [--dry-run]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PQueue from "p-queue";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const APPLE_CONFIRM_RADIUS_M = 150;
const GOOGLE_CONFIRM_RADIUS_M = 50;
const GOOGLE_SEARCH_RADIUS_M = 300;
const GOSOM_TIMEOUT_S = 60;
const HTTP_FETCH_TIMEOUT_MS = 8000;
const MIN_NAME_LENGTH = 3;
const DEFAULT_BATCH = 99999;
const DEFAULT_MAX_RUNTIME_MIN = 55;
const ATTEMPTED_TTL_DAYS = 30;
const WORKER_CONCURRENCY = 6;

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// ── types ──────────────────────────────────────────────────────────────────

type TriState = "yes" | "no" | "unknown";
type PaymentKey = "cash" | "cards" | "contactless" | "girocard" | "mobile";
type Payment = Partial<Record<PaymentKey, TriState>>;

const PAYMENT_KEYS: readonly PaymentKey[] = [
  "cash",
  "cards",
  "contactless",
  "girocard",
  "mobile",
] as const;

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
    payment?: Payment;
    hours?: { raw: string };
    sources?: Source[];
    updated?: string;
    kind?: string;
    apple_id_attempted?: string;
    apple_attempted?: string;
    google_attempted?: string;
    [k: string]: unknown;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

// DuckDuckGo
interface DDGLocalResult {
  name?: string;
  coordinates?: { latitude?: number; longitude?: number };
  provider_meta?: { apple?: { place_id?: string } };
}
interface DDGLocalResponse {
  results?: DDGLocalResult[];
}

// Apple Place SSR
interface ApplePlaceAmenity {
  amenityPresent?: boolean;
  amenityId?: string;
}
interface AppleTimeRange {
  from: number; // seconds since midnight
  to: number;
}
interface AppleWeeklyHourEntry {
  day: string[];
  timeRange: AppleTimeRange[];
}
interface AppleBusinessHours {
  weeklyHours?: AppleWeeklyHourEntry[];
}
interface AppleExtract {
  amenities: ApplePlaceAmenity[];
  weeklyHours: AppleWeeklyHourEntry[];
}

// gosom Entry struct
interface GosomOpenHoursEntry {
  [day: string]: string[]; // gosom shape, often empty
}
interface GosomEntry {
  /** Custom id we encoded as `<query>#!#<id>` in the request keyword,
   *  surfaced back here so we can match rows to the feature that asked. */
  input_id?: string;
  title?: string;
  latitude?: number;
  longitude?: number;
  longtitude?: number; // gosom typo
  about?: Array<{ name?: string; options?: Array<{ name?: string; enabled?: boolean }> }>;
  open_hours?: GosomOpenHoursEntry;
  place_id?: string;
  cid?: string;
}

interface Stats {
  considered: number;
  needs_id: number;
  needs_payment: number;
  needs_hours: number;
  ids_resolved: number;
  apple_features_touched: number;
  google_features_touched: number;
  payment_keys_written: number;
  hours_written: number;
  no_apple_match: number;
  no_google_match: number;
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

/**
 * "Have we learned enough about this kiosk's payment story?"
 *
 * The user-facing question is essentially "can I pay without cash?", and
 * any one of `cards` / `contactless` / `mobile` answers it (no matter the
 * value — `no` is just as useful as `yes`). If we know any of those, we
 * don't chase the others.
 *
 * Cash is excluded entirely: it's the implicit German default. Girocard
 * is the German-specific debit signal — useful when it's the only thing,
 * but not worth a scrape once any of cards/contactless/mobile is settled.
 * If a future scrape happens to return additional keys, mergePayment
 * still honours them — we just don't proactively re-enqueue on absence.
 */
function paymentHasAnyMissing(p: Payment | undefined): boolean {
  if (!p) return true;
  return p.cards === undefined && p.contactless === undefined && p.mobile === undefined;
}

function hoursMissing(feature: Feature): boolean {
  return !feature.properties.hours?.raw;
}

function existingAppleId(sources: Source[] | undefined): string | null {
  return sources?.find((s) => s.type === "apple" && s.id)?.id ?? null;
}

function existingGmapsId(sources: Source[] | undefined): string | null {
  const entry = sources?.find((s) => s.type === "gmaps" && s.id);
  if (!entry) return null;
  // The historical placeholder; treat as missing so we re-resolve.
  if (entry.id === "payment" || entry.id === "gmaps") return null;
  return entry.id;
}

function upsertSource(feature: Feature, type: "apple" | "gmaps", id: string): void {
  const sources = feature.properties.sources ?? [];
  const existing = sources.find((s) => s.type === type);
  if (existing) existing.id = id;
  else sources.push({ type, id });
  feature.properties.sources = sources;
}

function mergePayment(
  current: Payment | undefined,
  next: Payment,
): { merged: Payment; added: number } {
  const merged: Payment = { ...(current ?? {}) };
  let added = 0;
  for (const k of PAYMENT_KEYS) {
    if (merged[k] === undefined && next[k] !== undefined) {
      merged[k] = next[k];
      added++;
    }
  }
  return { merged, added };
}

async function findGeojsonFile(region: string): Promise<string | null> {
  const { readdir, stat } = await import("node:fs/promises");
  let found: string | null = null;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      if (found) return;
      const p = join(dir, entry);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else if (entry === `${region}.geojson`) found = p;
    }
  }
  await walk(join(REPO_ROOT, "data"));
  return found;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Probe the gosom sidecar's REST root. Returns false if no service is
 *  listening or the response shape doesn't match. The Google fallback path
 *  is disabled for the run when this returns false — Apple-only mode. */
async function gosomReady(): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(`${GOSOM_BASE}/api/v1/jobs`, {}, 3000);
    return resp.ok;
  } catch {
    return false;
  }
}

// ── DuckDuckGo (Apple place_id resolver) ──────────────────────────────────

let cachedVqd: string | null = null;
let vqdInFlight: Promise<string | null> | null = null;

async function getVqd(): Promise<string | null> {
  if (cachedVqd) return cachedVqd;
  if (vqdInFlight) return vqdInFlight;
  vqdInFlight = (async () => {
    try {
      const resp = await fetchWithTimeout(
        "https://duckduckgo.com/?q=maps&iar=maps",
        {
          headers: { "user-agent": SAFARI_UA, "accept-language": "de-DE,de;q=0.9,en;q=0.8" },
        },
        HTTP_FETCH_TIMEOUT_MS,
      );
      if (!resp.ok) return null;
      const html = await resp.text();
      const m = html.match(/vqd=["']?(\d-\d+(?:-\d+)?)/);
      cachedVqd = m?.[1] ?? null;
      return cachedVqd;
    } finally {
      vqdInFlight = null;
    }
  })();
  return vqdInFlight;
}

async function ddgResolveAppleId(
  name: string,
  lat: number,
  lng: number,
): Promise<string | null> {
  const vqd = await getVqd();
  const url = new URL("https://duckduckgo.com/local.js");
  url.searchParams.set("tg", "maps_places");
  url.searchParams.set("rt", "D");
  url.searchParams.set("q", name);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  if (vqd) url.searchParams.set("vqd", vqd);

  const resp = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        "user-agent": SAFARI_UA,
        accept: "application/json, text/plain, */*",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        referer: "https://duckduckgo.com/",
      },
    },
    HTTP_FETCH_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`ddg local.js ${resp.status}`);
  const json = (await resp.json()) as DDGLocalResponse;
  const results = json.results ?? [];
  let best: { placeId: string; meters: number } | null = null;
  for (const r of results) {
    const rLat = r.coordinates?.latitude;
    const rLng = r.coordinates?.longitude;
    const id = r.provider_meta?.apple?.place_id;
    if (typeof rLat !== "number" || typeof rLng !== "number" || !id) continue;
    const meters = haversineMeters(lat, lng, rLat, rLng);
    if (meters > APPLE_CONFIRM_RADIUS_M) continue;
    if (!best || meters < best.meters) best = { placeId: id, meters };
  }
  return best?.placeId ?? null;
}

// ── Apple Maps /place page ────────────────────────────────────────────────

function extractJsonArray(html: string, marker: string): string | null {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const arrStart = start + marker.length;
  let depth = 0;
  for (let i = arrStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return html.slice(arrStart, i + 1);
    }
  }
  return null;
}

function extractJsonObject(html: string, marker: string): string | null {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const objStart = start + marker.length;
  let depth = 0;
  for (let i = objStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(objStart, i + 1);
    }
  }
  return null;
}

async function fetchApplePlace(placeId: string): Promise<AppleExtract> {
  const url = `https://maps.apple.com/place?auid=${encodeURIComponent(placeId)}`;
  const resp = await fetchWithTimeout(
    url,
    {
      headers: {
        "user-agent": SAFARI_UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      },
    },
    HTTP_FETCH_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`maps.apple.com ${resp.status}`);
  const html = await resp.text();

  let amenities: ApplePlaceAmenity[] = [];
  const amenRaw = extractJsonArray(html, '"amenityV2":');
  if (amenRaw) {
    try {
      amenities = JSON.parse(amenRaw) as ApplePlaceAmenity[];
    } catch {
      /* ignore */
    }
  }

  let weeklyHours: AppleWeeklyHourEntry[] = [];
  const hoursRaw = extractJsonObject(html, '"businessHours":');
  if (hoursRaw) {
    try {
      const bh = JSON.parse(hoursRaw) as AppleBusinessHours;
      weeklyHours = bh.weeklyHours ?? [];
    } catch {
      /* ignore */
    }
  }

  return { amenities, weeklyHours };
}

/** Apple surfaces two payment amenities; both imply a card terminal, so
 *  `cards=yes` is inferred from either when amenityPresent=true. */
function amenitiesToPayment(amenities: ApplePlaceAmenity[]): Payment {
  const out: Payment = {};
  for (const a of amenities) {
    if (!a.amenityId) continue;
    const present = a.amenityPresent === true ? "yes" : a.amenityPresent === false ? "no" : null;
    if (!present) continue;
    if (a.amenityId === "crossbusiness.payments.applepay") {
      out.mobile = present;
      if (present === "yes") {
        out.contactless = out.contactless ?? "yes";
        out.cards = out.cards ?? "yes";
      }
    } else if (a.amenityId === "crossbusiness.payments.contactless_pay") {
      out.contactless = present;
      if (present === "yes") out.cards = out.cards ?? "yes";
    }
  }
  return out;
}

// ── Hours conversion ──────────────────────────────────────────────────────

const APPLE_DAY_TO_OSM: Record<string, string> = {
  MONDAY: "Mo",
  TUESDAY: "Tu",
  WEDNESDAY: "We",
  THURSDAY: "Th",
  FRIDAY: "Fr",
  SATURDAY: "Sa",
  SUNDAY: "Su",
};
const OSM_DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

function secondsToHm(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function condenseDays(days: string[]): string {
  // Map to OSM order indices, sort, and condense consecutive runs.
  const order = days
    .map((d) => OSM_DAY_ORDER.indexOf(d as (typeof OSM_DAY_ORDER)[number]))
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);
  if (order.length === 0) return "";
  const out: string[] = [];
  let runStart = order[0]!;
  let prev = order[0]!;
  for (let i = 1; i <= order.length; i++) {
    const cur = order[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    out.push(runStart === prev ? OSM_DAY_ORDER[runStart]! : `${OSM_DAY_ORDER[runStart]}-${OSM_DAY_ORDER[prev]}`);
    if (cur !== undefined) {
      runStart = cur;
      prev = cur;
    }
  }
  return out.join(",");
}

function appleHoursToOsm(weekly: AppleWeeklyHourEntry[]): string | null {
  if (weekly.length === 0) return null;
  const segments: string[] = [];
  for (const entry of weekly) {
    const days = entry.day.map((d) => APPLE_DAY_TO_OSM[d]).filter(Boolean) as string[];
    if (days.length === 0) continue;
    const ranges = entry.timeRange
      .map((tr) => `${secondsToHm(tr.from)}-${secondsToHm(tr.to)}`)
      .join(",");
    if (!ranges) continue;
    segments.push(`${condenseDays(days)} ${ranges}`);
  }
  return segments.length > 0 ? segments.join("; ") : null;
}

const GOSOM_DAY_TO_OSM: Record<string, string> = {
  Monday: "Mo",
  Tuesday: "Tu",
  Wednesday: "We",
  Thursday: "Th",
  Friday: "Fr",
  Saturday: "Sa",
  Sunday: "Su",
  // gosom returns localised day-of-week keys based on the scraper's `lang`
  // parameter (see gosom/gmaps/entry.go:getHours). We ask for lang=de, so
  // German keys are what we actually get back in practice.
  Montag: "Mo",
  Dienstag: "Tu",
  Mittwoch: "We",
  Donnerstag: "Th",
  Freitag: "Fr",
  Samstag: "Sa",
  Sonntag: "Su",
};

function gosomHoursToOsm(open: GosomOpenHoursEntry | undefined): string | null {
  if (!open) return null;
  const segments: string[] = [];
  for (const [day, ranges] of Object.entries(open)) {
    const osmDay = GOSOM_DAY_TO_OSM[day];
    if (!osmDay || !Array.isArray(ranges) || ranges.length === 0) continue;
    // Normalise "10 AM–10 PM" → "10:00-22:00" is too much for a small heuristic.
    // Only emit if ranges already look like "HH:MM-HH:MM".
    const clean = ranges.filter((r) => /^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}$/.test(r));
    if (clean.length === 0) continue;
    // Drop whitespace; turn en-dash (Google's separator in DE locale) into
    // the ASCII hyphen OSM opening_hours expects. Replacing en-dash with ""
    // here used to collapse "07:00–00:00" into "07:0000:00".
    segments.push(
      `${osmDay} ${clean.map((r) => r.replace(/\s+/g, "").replace(/–/g, "-")).join(",")}`,
    );
  }
  return segments.length > 0 ? segments.join("; ") : null;
}

// ── gosom (Google Maps scraper, HTTP sidecar) ─────────────────────────────

/** Base URL of the gosom REST API. The workflow runs it as a `services:`
 *  sidecar on localhost:8080; locally you can `docker run -d -p 8080:8080
 *  gosom/google-maps-scraper -data-folder /gmapsdata -c 4` to match. */
const GOSOM_BASE = process.env["GOSOM_BASE_URL"] ?? "http://localhost:8080";
const GOSOM_POLL_INTERVAL_MS = 2000;
// Batched gosom jobs amortize the Playwright cold-start across a chunk's
// keywords. Empirically the bottleneck isn't gosom but Google itself —
// after ~30 burst queries from a single IP, responses slow dramatically
// (rate-limit / CAPTCHA back-pressure), which makes large chunks stall.
// Sized small enough to stay under that threshold per chunk.
const GOSOM_CHUNK_SIZE = 15;
// Buffer added to the bounding-circle radius for each chunk so kiosks
// near the edge still resolve. Apple's confirm radius is 150m; google's
// search needs a bit more slack.
const GOSOM_CHUNK_RADIUS_BUFFER_M = 500;
const GOSOM_CHUNK_MIN_RADIUS_M = 1000;
// Generous because individual queries can stall on Google's throttle.
// max_time = COLD_START + PER_KEYWORD × len, capped by gosom's own
// `-exit-on-inactivity 3min`.
const GOSOM_PER_KEYWORD_BUDGET_S = 25;
const GOSOM_COLD_START_BUDGET_S = 150;
// Poll a bit longer than the job's own bound so gosom has time to
// finalise + write CSV before we give up.
const GOSOM_JOB_POLL_TIMEOUT_BUFFER_S = 120;

interface GosomJobCreateResponse {
  id: string;
}
interface GosomJobStatusResponse {
  ID: string;
  Status: "pending" | "running" | "ok" | "failed" | string;
}

interface BatchCandidate {
  featureId: string;
  name: string;
  lat: number;
  lng: number;
}

/** Submit a batch of candidates as a single gosom job. Each keyword carries
 *  the feature id via gosom's `#!#<id>` syntax (runner/jobs.go:parseQueryLine),
 *  which surfaces back as the result row's `input_id` for deterministic
 *  match-up. One ScrapeMateApp / one browser handles the whole batch; with
 *  `-c N` set on the container, N keywords run concurrently inside that
 *  browser via page reuse. */
async function gosomCreateBatchJob(batch: BatchCandidate[]): Promise<string> {
  if (batch.length === 0) throw new Error("gosomCreateBatchJob: empty batch");
  const { lat, lng, radius } = boundingCircle(batch);
  const maxTime = Math.max(
    180,
    GOSOM_COLD_START_BUDGET_S + GOSOM_PER_KEYWORD_BUDGET_S * batch.length,
  );
  const body = JSON.stringify({
    name: `tk-${Date.now()}-${batch.length}`,
    keywords: batch.map((c) => `${c.name}#!#${c.featureId}`),
    lang: "de",
    zoom: 18,
    depth: 1,
    max_time: maxTime,
    radius,
    lat: String(lat),
    lon: String(lng),
  });
  const resp = await fetchWithTimeout(
    `${GOSOM_BASE}/api/v1/jobs`,
    { method: "POST", headers: { "content-type": "application/json" }, body },
    HTTP_FETCH_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`gosom create ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as GosomJobCreateResponse;
  if (!json.id) throw new Error("gosom create: missing id");
  return json.id;
}

function boundingCircle(batch: BatchCandidate[]): { lat: number; lng: number; radius: number } {
  // Centroid (lat/lng average — fine for the city-scale neighbourhoods we
  // operate in; great-circle distortion is negligible).
  let sLat = 0;
  let sLng = 0;
  for (const c of batch) {
    sLat += c.lat;
    sLng += c.lng;
  }
  const lat = sLat / batch.length;
  const lng = sLng / batch.length;
  let maxM = 0;
  for (const c of batch) {
    const d = haversineMeters(lat, lng, c.lat, c.lng);
    if (d > maxM) maxM = d;
  }
  const radius = Math.max(
    GOSOM_CHUNK_MIN_RADIUS_M,
    Math.round(maxM + GOSOM_CHUNK_RADIUS_BUFFER_M),
  );
  return { lat, lng, radius };
}

async function gosomWaitForJob(id: string, maxTimeS: number): Promise<void> {
  const deadline = Date.now() + (maxTimeS + GOSOM_JOB_POLL_TIMEOUT_BUFFER_S) * 1000;
  while (Date.now() < deadline) {
    const resp = await fetchWithTimeout(
      `${GOSOM_BASE}/api/v1/jobs/${id}`,
      {},
      HTTP_FETCH_TIMEOUT_MS,
    );
    if (!resp.ok) throw new Error(`gosom status ${resp.status}`);
    const json = (await resp.json()) as GosomJobStatusResponse;
    if (json.Status === "ok") return;
    if (json.Status === "failed") throw new Error("gosom job failed");
    await new Promise((r) => setTimeout(r, GOSOM_POLL_INTERVAL_MS));
  }
  throw new Error(`gosom job ${id} timed out after ${maxTimeS}s`);
}

async function gosomDownload(id: string): Promise<string> {
  const resp = await fetchWithTimeout(
    `${GOSOM_BASE}/api/v1/jobs/${id}/download`,
    {},
    HTTP_FETCH_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`gosom download ${resp.status}`);
  return resp.text();
}

async function gosomDeleteJob(id: string): Promise<void> {
  // Best-effort housekeeping; don't fail the enrichment if cleanup fails.
  try {
    await fetchWithTimeout(
      `${GOSOM_BASE}/api/v1/jobs/${id}`,
      { method: "DELETE" },
      HTTP_FETCH_TIMEOUT_MS,
    );
  } catch {
    /* ignore */
  }
}

/** Run a batched gosom job + return the resulting entries grouped by
 *  the feature_id that we encoded with `#!#`. */
async function gosomBatch(batch: BatchCandidate[]): Promise<Map<string, GosomEntry[]>> {
  const maxTimeS = Math.max(
    180,
    GOSOM_COLD_START_BUDGET_S + GOSOM_PER_KEYWORD_BUDGET_S * batch.length,
  );
  const id = await gosomCreateBatchJob(batch);
  let csv: string | null = null;
  try {
    await gosomWaitForJob(id, maxTimeS);
    csv = await gosomDownload(id);
  } catch (err) {
    // Poll timeout (or status fetch failure). gosom's own mateCtx bounds
    // the scrape at max_time, so by the time we get here the CSV file
    // may well exist with whatever rows the scrape managed to write
    // before its context was cancelled. Best-effort download before we
    // give up — losing partial data is worse than the extra HTTP call.
    try {
      csv = await gosomDownload(id);
      console.error(
        `gosom poll-timeout; salvaged ${csv.length} bytes of CSV from job ${id}`,
      );
    } catch {
      // No salvageable data; rethrow original timeout for the chunk
      // error handler to count as `errored`.
      throw err;
    }
  } finally {
    await gosomDeleteJob(id);
  }
  const rows = await parseGosomCsv(csv);
  const grouped = new Map<string, GosomEntry[]>();
  for (const r of rows) {
    const key = r.input_id ?? "";
    if (!key) continue;
    const arr = grouped.get(key);
    if (arr) arr.push(r);
    else grouped.set(key, [r]);
  }
  return grouped;
}

/** Parse the CSV returned by `/api/v1/jobs/{id}/download`. Each row is one
 *  result; the columns we care about are `about` (JSON-encoded in-cell),
 *  `place_id`, `cid`, `latitude`, `longitude`. */
async function parseGosomCsv(csv: string): Promise<GosomEntry[]> {
  if (!csv.trim()) return [];
  const { parse } = await import("csv-parse/sync");
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  const out: GosomEntry[] = [];
  for (const row of rows) {
    let about: GosomEntry["about"];
    if (row["about"]) {
      try {
        about = JSON.parse(row["about"]) as GosomEntry["about"];
      } catch {
        about = undefined;
      }
    }
    let openHours: GosomOpenHoursEntry | undefined;
    if (row["open_hours"]) {
      try {
        openHours = JSON.parse(row["open_hours"]) as GosomOpenHoursEntry;
      } catch {
        openHours = undefined;
      }
    }
    out.push({
      input_id: row["input_id"] || undefined,
      title: row["title"] || undefined,
      latitude: row["latitude"] ? parseFloat(row["latitude"]) : undefined,
      longitude: row["longitude"] ? parseFloat(row["longitude"]) : undefined,
      about,
      open_hours: openHours,
      place_id: row["place_id"] || undefined,
      cid: row["cid"] || undefined,
    });
  }
  return out;
}

function gosomLng(r: GosomEntry): number | undefined {
  return typeof r.longitude === "number" ? r.longitude : r.longtitude;
}

function gosomMatch(results: GosomEntry[], lat: number, lng: number): GosomEntry | null {
  for (const r of results) {
    const rLng = gosomLng(r);
    if (typeof r.latitude !== "number" || typeof rLng !== "number") continue;
    if (haversineMeters(lat, lng, r.latitude, rLng) <= GOOGLE_CONFIRM_RADIUS_M) return r;
  }
  return null;
}

function gosomToPayment(entry: GosomEntry): Payment {
  const out: Payment = {};
  const section = entry.about?.find((a) => /zahlung|payment/i.test(a.name ?? ""));
  if (!section) return out;
  for (const opt of section.options ?? []) {
    const label = (opt.name ?? "").toLowerCase();
    const state: TriState = opt.enabled ? "yes" : "no";
    if (/girocard|ec[-\s]?karte|debit/.test(label)) {
      out.girocard = state;
      if (state === "yes") out.cards = out.cards ?? "yes";
    } else if (/kredit|credit/.test(label)) {
      out.cards = state;
    } else if (/kontaktlos|contactless|nfc/.test(label)) {
      out.contactless = state;
    } else if (/google\s?pay|apple\s?pay|mobile|samsung\s?pay/.test(label)) {
      out.mobile = state;
    } else if (/bargeld|cash/.test(label)) {
      out.cash = state;
    }
  }
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batch, region, maxRuntimeMin, dryRun } = args();
  if (!region) {
    process.stderr.write("--region <slug> is required\n");
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today);
  const startedAt = Date.now();
  const maxRuntimeMs = maxRuntimeMin * 60_000;

  const fileMaybe = await findGeojsonFile(region);
  if (!fileMaybe) {
    process.stdout.write(JSON.stringify({ skipped: "no such region", region }, null, 2) + "\n");
    return;
  }
  const file: string = fileMaybe;

  const doc = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
  const candidates: Array<{ index: number; feature: Feature }> = [];
  for (let i = 0; i < doc.features.length; i++) {
    const f = doc.features[i]!;
    if (f.properties.kind === "vending_machine") continue;
    if (!f.properties.name || f.properties.name.length < MIN_NAME_LENGTH) continue;
    const needsId = existingAppleId(f.properties.sources) === null;
    const needsPayment = paymentHasAnyMissing(f.properties.payment);
    const needsHrs = hoursMissing(f);
    if (!needsId && !needsPayment && !needsHrs) continue;
    candidates.push({ index: i, feature: f });
  }

  const considered = candidates.length;
  const todo = candidates.slice(0, batch);

  const stats: Stats = {
    considered,
    needs_id: todo.filter((c) => existingAppleId(c.feature.properties.sources) === null).length,
    needs_payment: todo.filter((c) => paymentHasAnyMissing(c.feature.properties.payment)).length,
    needs_hours: todo.filter((c) => hoursMissing(c.feature)).length,
    ids_resolved: 0,
    apple_features_touched: 0,
    google_features_touched: 0,
    payment_keys_written: 0,
    hours_written: 0,
    no_apple_match: 0,
    no_google_match: 0,
    errored: 0,
  };

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ...stats,
          region,
          file,
          would_query: todo.length,
          sample: todo.slice(0, 5).map((c) => ({
            id: c.feature.properties.id,
            name: c.feature.properties.name,
            apple_id: existingAppleId(c.feature.properties.sources),
            payment: c.feature.properties.payment ?? null,
            hours: c.feature.properties.hours?.raw ?? null,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const googleAvailable = await gosomReady();
  if (!googleAvailable) {
    console.error(
      `gosom sidecar not reachable at ${GOSOM_BASE} — Google fallback disabled for this run`,
    );
  } else {
    console.error(`gosom sidecar reachable at ${GOSOM_BASE}`);
  }

  // Per-provider rate limits. Pick conservative caps; tweak later if any
  // upstream complains. The intervalCap pattern caps requests-per-second.
  const ddgQueue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 });
  const appleQueue = new PQueue({ concurrency: 4, interval: 1000, intervalCap: 4 });
  const workerQueue = new PQueue({ concurrency: WORKER_CONCURRENCY });
  // Features that the Apple pass couldn't fully cover. Collected during
  // the per-feature loop and processed in chunks below — one gosom job
  // per chunk so the browser cold-start is paid once per chunk, not
  // per feature.
  const googleBatch: BatchCandidate[] = [];

  let stopRequested: Stats["stopped_reason"] | null = null;
  const requestStop = (reason: NonNullable<Stats["stopped_reason"]>): void => {
    if (!stopRequested) {
      stopRequested = reason;
      console.error(`stop requested: ${reason}`);
      // Drain queues: pause new work but let in-flight tasks finish.
      workerQueue.clear();
      ddgQueue.clear();
      appleQueue.clear();
    }
  };
  process.on("SIGTERM", () => requestStop("sigterm"));
  process.on("SIGINT", () => requestStop("sigterm"));

  // Watchdog for the wall-clock budget — checked from a timer so worker
  // tasks don't all need to inline the comparison.
  const watchdog = setInterval(() => {
    if (Date.now() - startedAt >= maxRuntimeMs) requestStop("max_runtime");
  }, 5000);

  // Per-file flush. We're processing a single region, so this is one file,
  // but the flush is async and we don't want two workers racing each other
  // on the write — serialize through a single-concurrency queue.
  const writeQueue = new PQueue({ concurrency: 1 });
  let dirty = false;
  async function flush(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    const snapshot = JSON.stringify(doc, null, 2) + "\n";
    await writeQueue.add(() => writeFile(file, snapshot, "utf8"));
  }

  async function processOne(c: { index: number; feature: Feature }): Promise<void> {
    if (stopRequested) return;
    const feature = doc.features[c.index]!;
    const name = feature.properties.name ?? "";
    const [lng, lat] = feature.geometry.coordinates;

    // Phase 1: Apple place_id via DDG (if not stored yet).
    // Skip the DDG round-trip when we've already tried recently and got
    // nothing — but DON'T skip the whole feature: Phase 3 (Google) can
    // still fill payment/hours even when Apple has no match for us.
    let appleId = existingAppleId(feature.properties.sources);
    if (
      !appleId &&
      daysSince(feature.properties.apple_id_attempted, todayDate) >= ATTEMPTED_TTL_DAYS
    ) {
      try {
        const id = await ddgQueue.add(() => ddgResolveAppleId(name, lat, lng));
        if (id) {
          appleId = id;
          upsertSource(feature, "apple", id);
          delete feature.properties.apple_id_attempted;
          stats.ids_resolved++;
          dirty = true;
          console.error(`[${feature.properties.id}] +apple-id ${id}`);
        } else {
          feature.properties.apple_id_attempted = today;
          stats.no_apple_match++;
          dirty = true;
        }
      } catch (err) {
        console.error(`[${feature.properties.id}] ddg error: ${(err as Error).message}`);
        feature.properties.apple_id_attempted = today;
        stats.errored++;
        dirty = true;
      }
    }
    if (stopRequested) return;

    // Phase 2: Apple place page → extract payment + hours.
    // Skip when the page was fetched recently and yielded nothing useful —
    // re-fetching maps.apple.com for a kiosk Apple doesn't have data on
    // is just burning the queue. The stamp is set on every *successful*
    // page fetch (see below) so we'll naturally retry after the TTL.
    if (
      appleId &&
      (paymentHasAnyMissing(feature.properties.payment) || hoursMissing(feature)) &&
      daysSince(feature.properties.apple_attempted, todayDate) >= ATTEMPTED_TTL_DAYS
    ) {
      try {
        const apple = await appleQueue.add(() => fetchApplePlace(appleId!));
        let touched = false;
        let payDelta = 0;
        let hoursDelta = false;
        if (paymentHasAnyMissing(feature.properties.payment)) {
          const incoming = amenitiesToPayment(apple.amenities);
          const { merged, added } = mergePayment(feature.properties.payment, incoming);
          if (added > 0) {
            feature.properties.payment = merged;
            feature.properties.updated = today;
            stats.payment_keys_written += added;
            payDelta = added;
            touched = true;
          }
        }
        if (hoursMissing(feature)) {
          const osm = appleHoursToOsm(apple.weeklyHours);
          if (osm) {
            feature.properties.hours = { raw: osm };
            feature.properties.updated = today;
            stats.hours_written++;
            hoursDelta = true;
            touched = true;
          }
        }
        // Stamp regardless of whether we got new data — the page was
        // reachable; if it yielded nothing this time it'll yield nothing
        // tomorrow either. Don't stamp on error (catch block) so a
        // transient network blip retries on the next run.
        feature.properties.apple_attempted = today;
        dirty = true;
        if (touched) {
          stats.apple_features_touched++;
          console.error(
            `[${feature.properties.id}] +apple ${payDelta > 0 ? `payment(${payDelta})` : ""}${
              payDelta > 0 && hoursDelta ? " " : ""
            }${hoursDelta ? "hours" : ""}`.trim(),
          );
        } else {
          console.error(`[${feature.properties.id}] apple: no usable data`);
        }
      } catch (err) {
        console.error(`[${feature.properties.id}] apple error: ${(err as Error).message}`);
        stats.errored++;
      }
    }
    if (stopRequested) return;

    // Note this feature for the batched Google pass below if Apple didn't
    // fully cover it. We defer the actual gosom calls so the script can
    // submit chunks of keywords as single jobs — one Playwright cold-start
    // amortised across the whole chunk.
    if (
      googleAvailable &&
      (paymentHasAnyMissing(feature.properties.payment) || hoursMissing(feature)) &&
      daysSince(feature.properties.google_attempted, todayDate) >= ATTEMPTED_TTL_DAYS
    ) {
      googleBatch.push({
        featureId: feature.properties.id,
        name,
        lat,
        lng,
      });
    }

    // Periodic flush so progress survives a SIGTERM at any point.
    await flush();
  }

  for (const c of todo) workerQueue.add(() => processOne(c));
  await workerQueue.onIdle();
  await flush();

  // Batched Google fallback: process the deferred candidates in chunks
  // so one ScrapeMateApp / browser handles each chunk's keywords with
  // page reuse instead of paying a fresh cold-start per feature.
  if (googleAvailable && googleBatch.length > 0 && !stopRequested) {
    console.error(
      `gosom batch: ${googleBatch.length} features in ${Math.ceil(googleBatch.length / GOSOM_CHUNK_SIZE)} chunk(s)`,
    );
    // Stable index lookup for in-place feature updates by id.
    const indexById = new Map<string, number>();
    for (let i = 0; i < doc.features.length; i++) {
      const id = doc.features[i]?.properties.id;
      if (id) indexById.set(id, i);
    }
    for (let off = 0; off < googleBatch.length; off += GOSOM_CHUNK_SIZE) {
      if (stopRequested) break;
      if (Date.now() - startedAt >= maxRuntimeMs) {
        requestStop("max_runtime");
        break;
      }
      const chunk = googleBatch.slice(off, off + GOSOM_CHUNK_SIZE);
      const chunkIdx = Math.floor(off / GOSOM_CHUNK_SIZE) + 1;
      const chunkCount = Math.ceil(googleBatch.length / GOSOM_CHUNK_SIZE);
      console.error(`gosom chunk ${chunkIdx}/${chunkCount} (${chunk.length} features)`);
      const chunkStart = Date.now();
      let grouped: Map<string, GosomEntry[]>;
      try {
        grouped = await gosomBatch(chunk);
        const elapsedS = ((Date.now() - chunkStart) / 1000).toFixed(1);
        console.error(`gosom chunk ${chunkIdx} done in ${elapsedS}s`);
      } catch (err) {
        // Chunk failed wholesale (timeout, gosom error). Don't stamp
        // `google_attempted` — we never got a real answer for these
        // features, so the next run picks them up. Bail out of the
        // chunk loop entirely: if gosom timed out / rate-limited once,
        // the remaining chunks face the same conditions and will burn
        // wall-clock for nothing.
        const elapsedS = ((Date.now() - chunkStart) / 1000).toFixed(1);
        const remaining = googleBatch.length - off;
        console.error(
          `gosom chunk ${chunkIdx} error after ${elapsedS}s: ${(err as Error).message} — aborting google phase; ${remaining} features deferred to next run`,
        );
        stats.errored += remaining;
        break;
      }
      for (const c of chunk) {
        const idx = indexById.get(c.featureId);
        if (idx === undefined) continue;
        const feature = doc.features[idx];
        if (!feature) continue;
        const candidates = grouped.get(c.featureId) ?? [];
        const match = gosomMatch(candidates, c.lat, c.lng);
        if (!match) {
          feature.properties.google_attempted = today;
          stats.no_google_match++;
          dirty = true;
          console.error(`[${c.featureId}] google: no match within radius`);
          continue;
        }
        let touched = false;
        let stampedId = false;
        let payDelta = 0;
        let hoursDelta = false;
        const gid = match.place_id || match.cid;
        if (gid && existingGmapsId(feature.properties.sources) !== gid) {
          upsertSource(feature, "gmaps", gid);
          stampedId = true;
          touched = true;
        }
        if (paymentHasAnyMissing(feature.properties.payment)) {
          const incoming = gosomToPayment(match);
          const { merged, added } = mergePayment(feature.properties.payment, incoming);
          if (added > 0) {
            feature.properties.payment = merged;
            feature.properties.updated = today;
            stats.payment_keys_written += added;
            payDelta = added;
            touched = true;
          }
        }
        if (hoursMissing(feature)) {
          const osm = gosomHoursToOsm(match.open_hours);
          if (osm) {
            feature.properties.hours = { raw: osm };
            feature.properties.updated = today;
            stats.hours_written++;
            hoursDelta = true;
            touched = true;
          }
        }
        if (touched) {
          stats.google_features_touched++;
          const parts: string[] = [];
          if (stampedId) parts.push("id");
          if (payDelta > 0) parts.push(`payment(${payDelta})`);
          if (hoursDelta) parts.push("hours");
          console.error(`[${c.featureId}] +google ${parts.join(" ")}`);
        } else {
          console.error(`[${c.featureId}] google: match, no new data`);
        }
        // Stamp google_attempted on EVERY successful gosom response —
        // whether match-with-data, match-without-data, or no match. The
        // semantic is "we did query Google about this feature within the
        // last 30 days; revisit then". Without this, features Google
        // matches but has nothing new for keep cycling through every
        // run forever (Apple already filled the payment block).
        feature.properties.google_attempted = today;
        dirty = true;
      }
      await flush();
    }
  }

  clearInterval(watchdog);

  stats.stopped_reason = stopRequested ?? "batch_done";
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
