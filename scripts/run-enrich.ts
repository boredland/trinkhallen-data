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

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PQueue from "p-queue";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const TMP_DIR = join(REPO_ROOT, ".tmp/enrich");
const SCRAPER_IMAGE = "gosom/google-maps-scraper";
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
  skipped_recent_attempt: number;
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

function paymentHasAnyMissing(p: Payment | undefined): boolean {
  return !p || PAYMENT_KEYS.some((k) => p[k] === undefined);
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

function isDockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
  return r.status === 0;
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
    segments.push(`${osmDay} ${clean.map((r) => r.replace(/\s|–/g, "")).join(",")}`);
  }
  return segments.length > 0 ? segments.join("; ") : null;
}

// ── gosom (Google Maps scraper) ───────────────────────────────────────────

async function gosomQuery(name: string, lat: number, lng: number): Promise<GosomEntry[]> {
  mkdirSync(TMP_DIR, { recursive: true });
  const inputPath = join(TMP_DIR, `in-${Math.random().toString(36).slice(2, 8)}.txt`);
  const outputPath = join(TMP_DIR, `out-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(inputPath, `${name}\n`, "utf8");
  await rm(outputPath, { force: true });
  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${TMP_DIR}:/work`,
    "-v",
    "gmaps-playwright-cache:/opt",
    SCRAPER_IMAGE,
    "-input",
    `/work/${inputPath.split("/").pop()}`,
    "-results",
    `/work/${outputPath.split("/").pop()}`,
    "-json",
    "-geo",
    `${lat},${lng}`,
    "-radius",
    String(GOOGLE_SEARCH_RADIUS_M),
    "-zoom",
    "18",
    "-depth",
    "1",
    "-c",
    "1",
    "-exit-on-inactivity",
    `${GOSOM_TIMEOUT_S}s`,
  ];
  // gosom's `-exit-on-inactivity` is supposed to bound the run, but a hung
  // Playwright process inside the container can pin us. execFileSync blocks
  // the event loop, so a stall here would also block our SIGTERM / max-
  // runtime watchdog. Hard cap at 2× the gosom inactivity timeout + 30 s
  // for docker startup; SIGKILL on overrun.
  try {
    execFileSync("docker", dockerArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: (GOSOM_TIMEOUT_S * 2 + 30) * 1000,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const e = err as { signal?: string; status?: number; message?: string };
    throw new Error(`gosom ${e.signal ?? e.status ?? "failed"}: ${e.message ?? ""}`.trim());
  }

  const buf = await readFile(outputPath, "utf8").catch(() => "");
  await rm(inputPath, { force: true });
  await rm(outputPath, { force: true });
  if (!buf.trim()) return [];
  try {
    const arr = JSON.parse(buf);
    if (Array.isArray(arr)) return arr as GosomEntry[];
    return [arr as GosomEntry];
  } catch {
    const out: GosomEntry[] = [];
    for (const line of buf.split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as GosomEntry);
      } catch {
        /* skip */
      }
    }
    return out;
  }
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
  let skippedRecentAttempt = 0;
  for (let i = 0; i < doc.features.length; i++) {
    const f = doc.features[i]!;
    if (f.properties.kind === "vending_machine") continue;
    if (!f.properties.name || f.properties.name.length < MIN_NAME_LENGTH) continue;
    const needsId = existingAppleId(f.properties.sources) === null;
    const needsPayment = paymentHasAnyMissing(f.properties.payment);
    const needsHrs = hoursMissing(f);
    if (!needsId && !needsPayment && !needsHrs) continue;
    if (needsId && daysSince(f.properties.apple_id_attempted, todayDate) < ATTEMPTED_TTL_DAYS) {
      skippedRecentAttempt++;
      continue;
    }
    candidates.push({ index: i, feature: f });
  }

  const considered = candidates.length;
  const todo = candidates.slice(0, batch);

  const stats: Stats = {
    considered,
    skipped_recent_attempt: skippedRecentAttempt,
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

  const dockerOk = isDockerAvailable();
  if (!dockerOk) {
    console.error("docker unavailable — Google fallback is disabled for this run");
  } else {
    console.error(`Pulling ${SCRAPER_IMAGE}…`);
    spawnSync("docker", ["pull", SCRAPER_IMAGE], { stdio: ["ignore", "ignore", "inherit"] });
  }

  // Per-provider rate limits. Pick conservative caps; tweak later if any
  // upstream complains. The intervalCap pattern caps requests-per-second.
  const ddgQueue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 });
  const appleQueue = new PQueue({ concurrency: 4, interval: 1000, intervalCap: 4 });
  // gosom is heavy (docker + Playwright); keep it serial.
  const googleQueue = new PQueue({ concurrency: 1, interval: 1500, intervalCap: 1 });
  const workerQueue = new PQueue({ concurrency: WORKER_CONCURRENCY });

  let stopRequested: Stats["stopped_reason"] | null = null;
  const requestStop = (reason: NonNullable<Stats["stopped_reason"]>): void => {
    if (!stopRequested) {
      stopRequested = reason;
      console.error(`stop requested: ${reason}`);
      // Drain queues: pause new work but let in-flight tasks finish.
      workerQueue.clear();
      ddgQueue.clear();
      appleQueue.clear();
      googleQueue.clear();
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
    let appleId = existingAppleId(feature.properties.sources);
    if (!appleId) {
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
    if (appleId && (paymentHasAnyMissing(feature.properties.payment) || hoursMissing(feature))) {
      try {
        const apple = await appleQueue.add(() => fetchApplePlace(appleId!));
        let touched = false;
        if (paymentHasAnyMissing(feature.properties.payment)) {
          const incoming = amenitiesToPayment(apple.amenities);
          const { merged, added } = mergePayment(feature.properties.payment, incoming);
          if (added > 0) {
            feature.properties.payment = merged;
            feature.properties.updated = today;
            stats.payment_keys_written += added;
            touched = true;
          }
        }
        if (hoursMissing(feature)) {
          const osm = appleHoursToOsm(apple.weeklyHours);
          if (osm) {
            feature.properties.hours = { raw: osm };
            feature.properties.updated = today;
            stats.hours_written++;
            touched = true;
          }
        }
        if (touched) {
          stats.apple_features_touched++;
          dirty = true;
        }
      } catch (err) {
        console.error(`[${feature.properties.id}] apple error: ${(err as Error).message}`);
        stats.errored++;
      }
    }
    if (stopRequested) return;

    // Phase 3: Google fallback for anything Apple didn't cover.
    if (
      dockerOk &&
      (paymentHasAnyMissing(feature.properties.payment) || hoursMissing(feature)) &&
      daysSince(feature.properties.google_attempted, todayDate) >= ATTEMPTED_TTL_DAYS
    ) {
      try {
        const results = await googleQueue.add(() => gosomQuery(name, lat, lng));
        const match = gosomMatch(results, lat, lng);
        if (match) {
          let touched = false;
          // Stamp the gmaps id while we're here.
          const gid = match.place_id || match.cid;
          if (gid && existingGmapsId(feature.properties.sources) !== gid) {
            upsertSource(feature, "gmaps", gid);
            touched = true;
          }
          if (paymentHasAnyMissing(feature.properties.payment)) {
            const incoming = gosomToPayment(match);
            const { merged, added } = mergePayment(feature.properties.payment, incoming);
            if (added > 0) {
              feature.properties.payment = merged;
              feature.properties.updated = today;
              stats.payment_keys_written += added;
              touched = true;
            }
          }
          if (hoursMissing(feature)) {
            const osm = gosomHoursToOsm(match.open_hours);
            if (osm) {
              feature.properties.hours = { raw: osm };
              feature.properties.updated = today;
              stats.hours_written++;
              touched = true;
            }
          }
          if (touched) {
            stats.google_features_touched++;
            dirty = true;
          }
        } else {
          feature.properties.google_attempted = today;
          stats.no_google_match++;
          dirty = true;
        }
      } catch (err) {
        console.error(`[${feature.properties.id}] gosom error: ${(err as Error).message}`);
        feature.properties.google_attempted = today;
        stats.errored++;
        dirty = true;
      }
    }

    // Periodic flush so progress survives a SIGTERM at any point.
    await flush();
  }

  for (const c of todo) workerQueue.add(() => processOne(c));
  await workerQueue.onIdle();
  await flush();
  clearInterval(watchdog);

  stats.stopped_reason = stopRequested ?? "batch_done";
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
