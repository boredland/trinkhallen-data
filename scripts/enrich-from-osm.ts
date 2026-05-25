/**
 * OSM enrichment for existing features.
 *
 * For every feature in data/**.geojson that doesn't already carry an
 * `sources[].type === "osm"` entry, ask Overpass for kiosk-like POIs in the
 * region bbox, find the best candidate by combined name-similarity +
 * proximity score, and (when confident) backfill missing fields:
 *
 *   hours.raw          ← OSM `opening_hours`
 *   payment.*          ← OSM `payment:*` keys mapped to our tri-state
 *   address.*          ← OSM `addr:*` (only when our field is blank)
 *   tags[]             ← controlled-vocab tags inferred from OSM
 *                        (`toilets=yes` → `wc`, `wheelchair=yes` →
 *                        `barrierefrei`, `outdoor_seating=yes` → `draussen`,
 *                        `indoor_seating=yes` → `sitzgelegenheiten`)
 *   sources            ← appended with the matched `osm` entry so the weekly
 *                        scrape (osm-to-geojson.ts) keeps it in sync
 *
 * Conservative defaults — we never OVERWRITE an existing value, only fill
 * blanks. Conflicts (OSM disagrees with us on a present field) go into the
 * `_enrichment-conflicts.csv` for human triage.
 *
 * Usage: pnpm tsx scripts/enrich-from-osm.ts [--region <slug>]
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canWrite, stamp, type SourceName } from "./lib/sources.ts";
import { cleanOpeningHours } from "./lib/opening-hours.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const OVERPASS = process.env["OVERPASS_ENDPOINT"] ?? "https://overpass-api.de/api/interpreter";
const USER_AGENT = "trinkhallen-data/0.1 enrich-from-osm (https://github.com/boredland/trinkhallen-data)";

// ── tunables ────────────────────────────────────────────────────────────────
const MAX_DISTANCE_M = 25; // candidates farther than this aren't considered

// Photon reverse-geocoder fallback. Many OSM kiosks come in with no addr:*
// tags at all, so the OSM-tag backfill above can't help them. After the
// match pass we walk any remaining feature with a missing address and
// ask Photon (https://photon.komoot.io/, OSM-backed, free, ~1 req/s).
const PHOTON_BASE = "https://photon.komoot.io";
const PHOTON_DELAY_MS = 1100; // ~1 req/s, mild buffer
const PHOTON_MAX_HIT_DISTANCE_M = 50;

// A match is accepted if ANY of these is true. Single combined-score
// thresholds were too conservative: identical-named OSM POIs 17 m away
// were stuck in "uncertain" alongside genuine ambiguities. Two independent
// signals (strong name OR very-close distance) each justify auto-accept.
function acceptMatch(combined: number, distance: number, nameSim: number): boolean {
  if (combined >= 0.65) return true;                          // weighted score
  if (nameSim >= 0.8  && distance <= MAX_DISTANCE_M) return true; // identical/near-identical names
  if (distance <= 15  && nameSim >= 0.45) return true;        // close + decent name
  if (distance <= 3   && nameSim >= 0.25) return true;        // essentially the same building
  return false;
}

// Combined-score floor for the review CSV. Sub-threshold candidates aren't
// "almost-matches" — they're just the tail of a fuzzy-search ranking, with
// near-zero signal. Raising 0.45 → 0.5 drops ~30 noise rows per run.
const UNCERTAIN_SCORE = 0.5;

// ── types ───────────────────────────────────────────────────────────────────
type TriState = "yes" | "no" | "unknown";

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address: Record<string, string | undefined>;
    hours?: { raw: string };
    tags?: string[];
    payment?: Partial<Record<"cash" | "cards" | "contactless" | "girocard" | "mobile", TriState>>;
    sources?: Array<{ type: string; id: string; version?: number }>;
    sources_by_field?: Record<string, string>;
    created?: string;
    updated?: string;
    [k: string]: unknown;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

interface OsmCandidate {
  type: "node" | "way" | "relation";
  id: number;
  version: number;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

// ── normalisation + similarity ──────────────────────────────────────────────

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(kiosk|trinkhalle|wasserhaeuschen|spaeti|spaetkauf|laden|shop|store)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): string[] {
  if (s.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient on character bigrams. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ab = bigrams(a);
  const bb = bigrams(b);
  if (ab.length === 0 || bb.length === 0) return 0;
  const aMap = new Map<string, number>();
  for (const g of ab) aMap.set(g, (aMap.get(g) ?? 0) + 1);
  let intersection = 0;
  for (const g of bb) {
    const n = aMap.get(g);
    if (n && n > 0) {
      intersection++;
      aMap.set(g, n - 1);
    }
  }
  return (2 * intersection) / (ab.length + bb.length);
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── overpass ────────────────────────────────────────────────────────────────

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  version?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Germany sanity bbox — clip outlier features (the seed data has a handful
// of nodes at lng=-98 / 103 from upstream coord-flip bugs; they'd make
// the working bbox globe-wide and Overpass would refuse the query).
const DE_BBOX: [number, number, number, number] = [5.87, 47.27, 15.04, 55.06];

function isInGermany(lng: number, lat: number): boolean {
  return lng >= DE_BBOX[0] && lng <= DE_BBOX[2] && lat >= DE_BBOX[1] && lat <= DE_BBOX[3];
}

function bbox(features: Feature[], pad = 0.005): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w - pad, s - pad, e + pad, n + pad];
}

/** Compute the set of ~0.5° tiles that actually contain features. Tiling
 *  the entire region bbox uniformly would query hundreds of empty cells;
 *  this targets only the cells we care about. */
function tilesFromFeatures(features: Feature[], step = 0.5): [number, number, number, number][] {
  const seen = new Set<string>();
  const tiles: [number, number, number, number][] = [];
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    const tx = Math.floor(lng / step) * step;
    const ty = Math.floor(lat / step) * step;
    const key = `${tx.toFixed(2)},${ty.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Small overlap so a feature near the edge of one tile still picks up
    // OSM neighbours in the adjacent one.
    const pad = 0.01;
    tiles.push([tx - pad, ty - pad, tx + step + pad, ty + step + pad]);
  }
  return tiles;
}

async function fetchOsmInBbox(b: [number, number, number, number]): Promise<OsmCandidate[]> {
  const [w, s, e, n] = b;
  // Broaden the tag filter to catch kiosks that OSM mappers categorised
  // differently. The original shop=kiosk|beverages|convenience missed:
  //   - shop=alcohol / wine / tobacco / newsagent (common for German Spätis)
  //   - shop=deli / food
  //   - amenity=fast_food / cafe / pub / bar (Trinkhalle-as-bar overlap)
  // Adds tile size by maybe 20-40% but those are exactly the false-negatives
  // we were getting in the uncertain CSV (location matches, no shop=kiosk
  // candidate nearby).
  const query = `[out:json][timeout:180];
(
  nwr["shop"~"^(kiosk|beverages|convenience|alcohol|wine|tobacco|newsagent|deli|food)$"](${s},${w},${n},${e});
  nwr["amenity"~"^(fast_food|cafe|pub|bar)$"]["name"](${s},${w},${n},${e});
);
out center tags;`;

  // Retry on 5xx + 429 with exponential backoff. Overpass is volunteer-run
  // and can be flaky under load, especially at tile boundaries with lots of
  // POIs. Cap at 5 attempts; longer than that means something's wrong.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(OVERPASS, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (resp.ok) {
        const json = (await resp.json()) as { elements: OverpassElement[] };
        const out: OsmCandidate[] = [];
        for (const el of json.elements) {
          const lat = el.lat ?? el.center?.lat;
          const lng = el.lon ?? el.center?.lon;
          if (lat === undefined || lng === undefined) continue;
          out.push({
            type: el.type,
            id: el.id,
            version: el.version ?? 0,
            lat,
            lng,
            tags: el.tags ?? {},
          });
        }
        return out;
      }
      // 404 = empty result on some Overpass mirrors; treat as no data
      if (resp.status === 404) return [];
      // 5xx / 429 → retryable; everything else is a hard fail
      if (resp.status < 500 && resp.status !== 429) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Overpass HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    // Backoff: 2s, 5s, 12s, 30s, 60s
    const wait = [2_000, 5_000, 12_000, 30_000, 60_000][attempt]!;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`Overpass failed after retries: ${(lastErr as Error)?.message ?? "unknown"}`);
}

async function fetchOsmInTiles(tiles: [number, number, number, number][]): Promise<OsmCandidate[]> {
  const all: OsmCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    process.stderr.write(`  tile ${i + 1}/${tiles.length} [${tile.map((n) => n.toFixed(2)).join(",")}] … `);
    try {
      const got = await fetchOsmInBbox(tile);
      for (const c of got) {
        const key = `${c.type}/${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(c);
      }
      process.stderr.write(`${got.length}\n`);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
    // Polite delay between Overpass requests; the server runs on volunteer
    // hardware and we don't want to get rate-limited.
    await new Promise((r) => setTimeout(r, 1100));
  }
  return all;
}

// ── matching ────────────────────────────────────────────────────────────────

interface Match {
  candidate: OsmCandidate;
  score: number;
  distance: number;
  nameSim: number;
}

function scoreCandidate(feature: Feature, c: OsmCandidate): Match | null {
  const [lng, lat] = feature.geometry.coordinates;
  const distance = haversineMeters(lat, lng, c.lat, c.lng);
  if (distance > MAX_DISTANCE_M) return null;

  const osmName = c.tags["name"] ?? "";
  const ourName = feature.properties.name;
  const nameSim = dice(normalise(ourName), normalise(osmName));

  // Distance score: linear 1 at 0m → 0 at MAX_DISTANCE_M
  const distScore = Math.max(0, 1 - distance / MAX_DISTANCE_M);

  // Weighted combination. Name is the stronger signal because OSM coords can
  // be off by 5-15m even for the same POI (different mappers, different
  // entrance pins). 0.55 name + 0.45 distance gave the cleanest separation
  // on Frankfurt test data.
  const score = 0.55 * nameSim + 0.45 * distScore;
  return { candidate: c, score, distance, nameSim };
}

function findBestMatch(feature: Feature, candidates: OsmCandidate[]): Match | null {
  let best: Match | null = null;
  for (const c of candidates) {
    const m = scoreCandidate(feature, c);
    if (!m) continue;
    if (best === null || m.score > best.score) best = m;
  }
  return best;
}

// ── backfill ────────────────────────────────────────────────────────────────

function alreadyHasOsmSource(f: Feature): boolean {
  return (f.properties.sources ?? []).some((s) => s.type === "osm");
}

function isFreshSince(f: Feature, sinceMs: number): boolean {
  const c = f.properties.created ? Date.parse(f.properties.created) : NaN;
  const u = f.properties.updated ? Date.parse(f.properties.updated) : NaN;
  const latest = Math.max(Number.isFinite(c) ? c : 0, Number.isFinite(u) ? u : 0);
  // Date-less features (rare — old hopfenstop seed rows) are treated as stale:
  // incremental runs skip them entirely, but a periodic --full sweep still
  // re-attempts them in case OSM has gained a match since the last sweep.
  if (latest === 0) return false;
  return latest >= sinceMs;
}

function tri(v: string | undefined): TriState | undefined {
  if (v === undefined) return undefined;
  if (v === "yes" || v === "only") return "yes";
  if (v === "no") return "no";
  return "unknown";
}

interface BackfillStats {
  hours: boolean;
  payment: number;
  address: number;
  tags: number;
}

function backfill(f: Feature, c: OsmCandidate): BackfillStats {
  const stats: BackfillStats = { hours: false, payment: 0, address: 0, tags: 0 };
  const t = c.tags;
  const SRC: SourceName = "osm";
  const sbf = f.properties.sources_by_field;

  // hours — fill or refresh if osm rank ≥ current source (so a hopfenstop
  // hours string can be replaced, but an apple/google one can't).
  // cleanOpeningHours drops degenerate strings like `Mo-Su 00:00-00:00`
  // that some OSM mappers use as a 24/7-or-closed proxy.
  const oh = cleanOpeningHours(t["opening_hours"]);
  if (oh && canWrite(sbf, "hours", SRC)) {
    if (f.properties.hours?.raw !== oh) {
      f.properties.hours = { raw: oh };
      stats.hours = true;
    }
    stamp(f.properties, "hours", SRC);
  }

  // payment — backfill blanks unconditionally, overwrite settled values
  // only when osm rank ≥ the per-key stamp.
  const pay = f.properties.payment ?? {};
  const setKey = (key: "cash" | "cards" | "contactless" | "girocard" | "mobile", value: TriState | undefined) => {
    if (value === undefined || value === "unknown") return;
    const path = `payment.${key}`;
    const current = pay[key];
    const effectivelyMissing = current === undefined || current === "unknown";
    if (effectivelyMissing) {
      pay[key] = value;
      stamp(f.properties, path, SRC);
      stats.payment++;
    } else if (current !== value && canWrite(f.properties.sources_by_field, path, SRC)) {
      pay[key] = value;
      stamp(f.properties, path, SRC);
      stats.payment++;
    }
  };
  setKey("cash", tri(t["payment:cash"]));
  const credit = tri(t["payment:credit_cards"]);
  const debit = tri(t["payment:debit_cards"]);
  if (credit === "yes" || debit === "yes") setKey("cards", "yes");
  else if (credit === "no" && debit === "no") setKey("cards", "no");
  setKey("contactless", tri(t["payment:contactless"]));
  setKey("girocard", tri(t["payment:girocard"] ?? t["payment:ec_cards"]));
  const apple = tri(t["payment:apple_pay"]);
  const google = tri(t["payment:google_pay"]);
  if (apple === "yes" || google === "yes") setKey("mobile", "yes");
  else if (apple === "no" && google === "no") setKey("mobile", "no");
  if (Object.keys(pay).length > 0) f.properties.payment = pay;

  // address — same shape, per-key.
  const addr = f.properties.address ?? {};
  const setAddr = (
    ours: "street" | "number" | "postalcode" | "city" | "district",
    value: string | undefined,
  ) => {
    if (!value) return;
    const path = `address.${ours}`;
    const current = addr[ours];
    if (!current) {
      addr[ours] = value;
      stamp(f.properties, path, SRC);
      stats.address++;
    } else if (current !== value && canWrite(f.properties.sources_by_field, path, SRC)) {
      addr[ours] = value;
      stamp(f.properties, path, SRC);
      stats.address++;
    }
  };
  setAddr("street", t["addr:street"]);
  setAddr("number", t["addr:housenumber"]);
  if (t["addr:postcode"] && /^\d{5}$/.test(t["addr:postcode"])) {
    setAddr("postalcode", t["addr:postcode"]);
  }
  setAddr("city", t["addr:city"]);
  setAddr("district", t["addr:suburb"] ?? t["addr:neighbourhood"]);
  f.properties.address = addr;

  // tags — inferred from OSM amenity-style tags
  const existing = new Set(f.properties.tags ?? []);
  const addTag = (slug: string) => {
    if (!existing.has(slug)) {
      existing.add(slug);
      stats.tags++;
    }
  };
  if (t["toilets"] === "yes") addTag("wc");
  if (t["wheelchair"] === "yes") addTag("barrierefrei");
  if (t["outdoor_seating"] === "yes") addTag("draussen");
  if (t["indoor_seating"] === "yes" || t["seating"] === "yes") addTag("sitzgelegenheiten");
  if (t["covered"] === "yes") addTag("ueberdacht");
  if (t["smoking"] === "yes" || t["smoking"] === "outside") addTag("raucherbereich");
  if (t["vending"] === "drinks" || t["vending"] === "beverages") addTag("automat");
  if (existing.size > 0) f.properties.tags = [...existing].sort();

  // sources — append the OSM ref so the weekly scrape keeps it in sync
  const sources = f.properties.sources ?? [];
  sources.push({
    type: "osm",
    id: `${c.type === "node" ? "node" : "way"}/${c.id}`,
    version: c.version,
  });
  f.properties.sources = sources;

  f.properties.updated = new Date().toISOString().slice(0, 10);
  return stats;
}

// ── photon reverse-geocode address fallback ─────────────────────────────────

interface PhotonProps {
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  district?: string;
  country?: string;
}
interface PhotonResp {
  features: Array<{
    geometry: { coordinates: [number, number] };
    properties: PhotonProps;
  }>;
}

function needsAddress(f: Feature): boolean {
  const a = f.properties.address ?? {};
  return !a["street"] || !a["number"];
}

/** Haversine distance in metres. Local copy so we don't depend on any of the
 *  OSM-matcher distance helpers (which are scoped narrower). */
function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
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
  const resp = await fetch(
    `${PHOTON_BASE}/reverse?lat=${lat}&lon=${lng}&lang=de&radius=0.05&limit=5`,
    { headers: { "user-agent": USER_AGENT } },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as PhotonResp;
  if (!data.features?.length) return null;
  // Rank: street + number > number-only > street-only, then by distance.
  // Photon localises country names on lang=de, so accept both spellings.
  const okCountry = (c?: string) => !c || c === "Germany" || c === "Deutschland";
  let best: { props: PhotonProps; meters: number; score: number } | null = null;
  for (const hit of data.features) {
    const p = hit.properties;
    if (!okCountry(p.country)) continue;
    if (!p.street && !p.housenumber) continue;
    const [hLng, hLat] = hit.geometry.coordinates;
    const m = distMeters(lat, lng, hLat, hLng);
    if (m > PHOTON_MAX_HIT_DISTANCE_M) continue;
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

interface PhotonStats {
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
  capped: boolean;
}

async function photonFillFile(
  file: string,
  features: Feature[],
  budget: { remaining: number },
): Promise<{ touched: number; stats: PhotonStats }> {
  const stats: PhotonStats = {
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
    capped: false,
  };
  const candidates = features.filter(needsAddress);
  if (candidates.length === 0) return { touched: 0, stats };

  const today = new Date().toISOString().slice(0, 10);
  let touched = 0;
  for (const f of candidates) {
    if (budget.remaining <= 0) {
      stats.capped = true;
      break;
    }
    stats.considered++;
    const [lng, lat] = f.geometry.coordinates;
    let hit: PhotonProps | null = null;
    try {
      hit = await photonReverse(lat, lng);
      stats.queried++;
      budget.remaining--;
    } catch (err) {
      console.error(`  [${f.properties.id}] photon error: ${(err as Error).message}`);
      stats.errored++;
      continue;
    } finally {
      await new Promise((r) => setTimeout(r, PHOTON_DELAY_MS));
    }
    if (!hit) {
      stats.no_match++;
      continue;
    }
    stats.matched++;

    const a = f.properties.address ?? {};
    let changed = false;
    const fill = (key: string, value: string | undefined, stat: () => void): void => {
      if (!value) return;
      if (a[key]) return;
      a[key] = value;
      stamp(f.properties, `address.${key}`, "photon");
      stat();
      changed = true;
    };
    fill("street", hit.street, () => stats.filled_street++);
    fill("number", hit.housenumber, () => stats.filled_number++);
    fill("postalcode", hit.postcode, () => stats.filled_postalcode++);
    fill("city", hit.city, () => stats.filled_city++);
    fill("district", hit.district, () => stats.filled_district++);
    if (changed) {
      f.properties.address = a;
      f.properties.updated = today;
      touched++;
    }
  }
  return { touched, stats };
}

// ── walk + main ─────────────────────────────────────────────────────────────

async function findGeojsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir)) {
      const p = join(dir, entry);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else if (entry.endsWith(".geojson")) out.push(p);
    }
  }
  await walk(join(root, "data"));
  return out;
}

async function main(): Promise<void> {
  const wantSlugArg = process.argv.indexOf("--region");
  const wantSlug = wantSlugArg >= 0 ? process.argv[wantSlugArg + 1] : null;

  // --photon-only skips the Overpass match pass and runs only the Photon
  //   address backfill — used for the one-time backlog sweep.
  // --max-photon N caps Photon requests per run (default 500, since each
  //   one takes ~1.1s and the workflow has a hard timeout).
  const photonOnly = process.argv.includes("--photon-only");
  const maxPhotonArg = process.argv.indexOf("--max-photon");
  const maxPhoton =
    maxPhotonArg >= 0 ? Number.parseInt(process.argv[maxPhotonArg + 1] ?? "", 10) || 500 : 500;

  // --since <YYYY-MM-DD> (or empty for a full sweep) restricts the candidate
  // set to features whose max(created, updated) is on or after that date.
  // Each monthly run only re-attempts features that are actually fresh,
  // which collapses Overpass tile counts by an order of magnitude once the
  // dataset stabilises. --full overrides the env default for ad-hoc runs.
  const sinceArg = process.argv.indexOf("--since");
  const sinceRaw =
    process.argv.includes("--full")
      ? null
      : sinceArg >= 0
        ? (process.argv[sinceArg + 1] ?? null)
        : process.env["ENRICH_SINCE"] ?? null;
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
  if (sinceRaw && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid --since / ENRICH_SINCE value: ${sinceRaw}`);
  }
  if (Number.isFinite(sinceMs)) {
    console.error(`Filter: only features with created|updated >= ${sinceRaw} (full sweep skipped)`);
  } else {
    console.error("Filter: none (full sweep — every unmatched feature)");
  }

  const files = await findGeojsonFiles(REPO_ROOT);
  const conflicts: string[][] = []; // retained for future use; not currently written
  const uncertain: string[][] = [];
  const totals = {
    files: 0,
    candidates: 0,
    matched: 0,
    hours: 0,
    payment: 0,
    address: 0,
    tags: 0,
    skipped_stale: 0,
    photon_considered: 0,
    photon_matched: 0,
    photon_no_match: 0,
    photon_filled_street: 0,
    photon_filled_number: 0,
    photon_filled_postalcode: 0,
    photon_filled_city: 0,
    photon_filled_district: 0,
    photon_errored: 0,
    photon_capped: false,
  };
  const photonBudget = { remaining: maxPhoton };

  for (const file of files) {
    const slug = file.split("/").pop()!.replace(/\.geojson$/, "");
    if (wantSlug && slug !== wantSlug) continue;
    if (photonOnly) {
      // Photon-only mode: skip the Overpass match pass entirely; walk
      // every feature in the file with a missing address part.
      const collection = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
      const candidates = collection.features.filter(needsAddress);
      if (candidates.length === 0) {
        continue;
      }
      const inWindow = Number.isFinite(sinceMs)
        ? candidates.filter((f) => isFreshSince(f, sinceMs))
        : candidates;
      if (inWindow.length === 0) {
        continue;
      }
      console.error(`${slug}: photon-only over ${inWindow.length} features (${candidates.length - inWindow.length} stale skipped)`);
      const { touched, stats } = await photonFillFile(file, inWindow, photonBudget);
      totals.photon_considered += stats.considered;
      totals.photon_matched += stats.matched;
      totals.photon_no_match += stats.no_match;
      totals.photon_filled_street += stats.filled_street;
      totals.photon_filled_number += stats.filled_number;
      totals.photon_filled_postalcode += stats.filled_postalcode;
      totals.photon_filled_city += stats.filled_city;
      totals.photon_filled_district += stats.filled_district;
      totals.photon_errored += stats.errored;
      if (stats.capped) totals.photon_capped = true;
      console.error(`  photon: matched ${stats.matched}/${stats.considered}, touched ${touched}`);
      if (touched > 0) {
        await writeFile(file, `${JSON.stringify(collection, null, 2)}\n`, "utf8");
      }
      totals.files++;
      if (photonBudget.remaining <= 0) {
        console.error(`Photon budget exhausted (${maxPhoton} requests); stopping early.`);
        break;
      }
      continue;
    }

    const collection = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
    const allUnmatched = collection.features.filter((f) => !alreadyHasOsmSource(f));
    const unmatched = Number.isFinite(sinceMs)
      ? allUnmatched.filter((f) => isFreshSince(f, sinceMs))
      : allUnmatched;
    const staleSkipped = allUnmatched.length - unmatched.length;
    totals.skipped_stale += staleSkipped;
    if (unmatched.length === 0) {
      console.error(`${slug}: 0 unmatched features in window${staleSkipped ? ` (${staleSkipped} stale, skipped)` : ""}, skipping`);
      continue;
    }
    if (staleSkipped > 0) {
      console.error(`${slug}: ${unmatched.length} fresh features, ${staleSkipped} stale skipped`);
    }

    // Clip to Germany — the seed data has a handful of outlier features
    // with bogus coords that would otherwise drag the bbox globe-wide.
    const inGermany = unmatched.filter((f) => {
      const [lng, lat] = f.geometry.coordinates;
      return isInGermany(lng, lat);
    });
    const skipped = unmatched.length - inGermany.length;
    if (skipped > 0) {
      console.error(`${slug}: skipped ${skipped} features outside Germany bbox`);
    }
    if (inGermany.length === 0) continue;

    const tiles = tilesFromFeatures(inGermany);
    console.error(`${slug}: ${inGermany.length} candidates across ${tiles.length} tiles; querying Overpass…`);
    const candidates = await fetchOsmInTiles(tiles);
    console.error(`  → ${candidates.length} OSM POIs total`);
    totals.candidates += candidates.length;

    let fileMatched = 0;
    let fileFieldsAdded = 0;
    for (const f of collection.features) {
      if (alreadyHasOsmSource(f)) continue;
      const best = findBestMatch(f, candidates);
      if (!best) continue;
      if (acceptMatch(best.score, best.distance, best.nameSim)) {
        // No conflict logging — if we already have a value we trust it
        // (hopfenstop seed is community-curated; OSM disagreeing isn't
        // useful signal worth surfacing). The backfill() rules below
        // never overwrite an existing value anyway.
        const s = backfill(f, best.candidate);
        totals.hours += s.hours ? 1 : 0;
        totals.payment += s.payment;
        totals.address += s.address;
        totals.tags += s.tags;
        fileFieldsAdded += (s.hours ? 1 : 0) + s.payment + s.address + s.tags;
        fileMatched++;
      } else if (best.score >= UNCERTAIN_SCORE) {
        uncertain.push([
          slug,
          f.properties.id,
          f.properties.name,
          `${best.candidate.type}/${best.candidate.id}`,
          best.candidate.tags["name"] ?? "",
          best.score.toFixed(2),
          best.distance.toFixed(1),
          best.nameSim.toFixed(2),
        ]);
      }
    }
    console.error(`  matched ${fileMatched} features, added ${fileFieldsAdded} fields`);

    // Photon fallback: walk any feature still missing street or number
    // after the OSM match pass (covers the case where neither our seed nor
    // the matched OSM POI carried `addr:*` tags).
    if (photonBudget.remaining > 0) {
      const { touched: photonTouched, stats: ps } = await photonFillFile(
        file,
        inGermany,
        photonBudget,
      );
      totals.photon_considered += ps.considered;
      totals.photon_matched += ps.matched;
      totals.photon_no_match += ps.no_match;
      totals.photon_filled_street += ps.filled_street;
      totals.photon_filled_number += ps.filled_number;
      totals.photon_filled_postalcode += ps.filled_postalcode;
      totals.photon_filled_city += ps.filled_city;
      totals.photon_filled_district += ps.filled_district;
      totals.photon_errored += ps.errored;
      if (ps.capped) totals.photon_capped = true;
      if (ps.considered > 0) {
        console.error(`  photon: matched ${ps.matched}/${ps.considered}, touched ${photonTouched}`);
      }
      if (photonTouched > 0 && fileMatched === 0) {
        // The OSM-match branch's "if fileMatched > 0" write below skips us;
        // do our own write so the photon-only fills don't get lost.
        await writeFile(file, `${JSON.stringify(collection, null, 2)}\n`, "utf8");
      }
    }

    if (fileMatched > 0) {
      await writeFile(file, JSON.stringify(collection, null, 2) + "\n", "utf8");
    }
    totals.files++;
    totals.matched += fileMatched;
    if (photonBudget.remaining <= 0) {
      console.error(`Photon budget exhausted (${maxPhoton} requests); finishing without further Photon calls.`);
    }
  }

  // (conflict logging removed — see comment in main loop)
  void conflicts;
  if (uncertain.length > 0) {
    await writeFile(
      join(REPO_ROOT, "_enrichment-uncertain.csv"),
      "region,feature_id,feature_name,osm_ref,osm_name,score,distance_m,name_sim\n" +
        uncertain.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n") +
        "\n",
    );
  }

  process.stdout.write(
    JSON.stringify({ ...totals, uncertain: uncertain.length, conflicts: conflicts.length }, null, 2) + "\n",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
