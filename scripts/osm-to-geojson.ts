/**
 * Fetch kiosk-like POIs from Overpass for one region and emit GeoJSON Features
 * matching our schema. Pure function — no fs writes.
 *
 * Run directly to print the FeatureCollection for one region to stdout:
 *   tsx scripts/osm-to-geojson.ts <region-slug>
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { stampAll } from "./lib/sources.ts";
import { cleanOpeningHours } from "./lib/opening-hours.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

export interface Region {
  slug: string;
  path: string;
  prefix: string;
  iso3166_2: string;
  admin_level: number;
  bbox: [number, number, number, number]; // [w, s, e, n]
  /** "city" (default): tight urban bbox, owns points by nearest-anchor.
   *  "rest": Bundesland-scale catch-all, queried via ISO area filter, only
   *  claims points that no city region owns. */
  role?: "city" | "rest";
  /** When set, a rest region's area filter is additionally clipped to `bbox`.
   *  For territories with no ISO area of their own — e.g. Belgium's German-
   *  speaking Community, which sits inside Wallonia — set iso3166_2 to the
   *  containing country/region and bbox to the territory, so the query is
   *  area ∩ bbox. Normal Bundesland rests leave this off (their bbox is just
   *  an envelope ⊇ the area, so clipping would be a no-op at best). */
  bbox_clip?: boolean;
}

export interface OsmFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address: { street?: string; number?: string; postalcode?: string; city?: string; district?: string };
    hours?: { raw: string };
    tags?: string[];
    payment?: Record<"cash" | "cards" | "contactless" | "girocard", "yes" | "no" | "unknown">;
    sources: Array<{ type: "osm"; id: string; version: number }>;
    /** Set when OSM tags identify this as something other than a manned
     *  kiosk. Consumers can filter or render differently. */
    kind?: "vending_machine" | "convenience" | "bar";
    created: string;
    updated: string;
    sources_by_field?: Record<string, string>;
  };
}

export async function loadRegions(): Promise<Region[]> {
  const txt = await readFile(resolve(REPO_ROOT, "regions.yml"), "utf8");
  const doc = YAML.parse(txt) as { regions: Region[] };
  return doc.regions;
}

function bboxCenter(r: Region): [number, number] {
  const [w, s, e, n] = r.bbox;
  return [(w + e) / 2, (s + n) / 2];
}

function bboxContains(r: Region, lng: number, lat: number): boolean {
  const [w, s, e, n] = r.bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

function squaredAnchorDistance(r: Region, lng: number, lat: number): number {
  const [cLng, cLat] = bboxCenter(r);
  const dLng = (lng - cLng) * Math.cos((lat * Math.PI) / 180);
  const dLat = lat - cLat;
  return dLng * dLng + dLat * dLat;
}

/**
 * A point belongs to exactly one region. Resolution order:
 *   1. City regions whose bbox contains the point — nearest anchor wins.
 *   2. Rest regions whose bbox contains the point — nearest anchor wins.
 * A city region always beats any rest region, so adding `hessen-rest` next
 * to `frankfurt` doesn't migrate Frankfurt features out of `frankfurt.geojson`.
 *
 * Returns true if `region` is that owner. Falls back to true if no region's
 * bbox contains the point (defensive: Overpass returned it inside ours).
 */
export function ownsFeature(
  region: Region,
  allRegions: Region[],
  lng: number,
  lat: number,
): boolean {
  const candidates = allRegions.filter((r) => bboxContains(r, lng, lat));
  if (candidates.length === 0) return true;
  const cities = candidates.filter((r) => (r.role ?? "city") === "city");
  const pool = cities.length > 0 ? cities : candidates;
  let best = pool[0]!;
  let bestD = squaredAnchorDistance(best, lng, lat);
  for (let i = 1; i < pool.length; i++) {
    const d = squaredAnchorDistance(pool[i]!, lng, lat);
    if (d < bestD) { best = pool[i]!; bestD = d; }
  }
  return best.slug === region.slug;
}

// Comma-separated; retries rotate through the list. Every public Overpass
// instance has multi-hour stretches of 504s or refused connections, so a
// retry against the same host rarely helps.
const OVERPASS_ENDPOINTS = (
  process.env["OVERPASS_ENDPOINT"] ??
  "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Server-side query budget, and the client-side cap on one attempt (request
// plus body). Real answers arrive in seconds; without the client cap a host
// that accepts the TCP connection and then stalls cost ~12 min per region and
// pushed the weekly run into the 90 min job timeout.
const QUERY_TIMEOUT_S = 120;
const ATTEMPT_TIMEOUT_MS = (QUERY_TIMEOUT_S + 30) * 1000;
// Index of the endpoint that last answered; the next region starts there
// instead of re-probing a host that is down for the rest of the run.
let preferredEndpoint = 0;
const USER_AGENT = "trinkhallen-data/0.1 (https://github.com/boredland/trinkhallen-data)";

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  version?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/** Which Overpass request a feature comes from. Each group is fetched and
 *  checked on its own, so a slow bar query can't sink the kiosk refresh. */
export type QueryGroup = "kiosk" | "convenience" | "bar";

export function queryGroupOf(kind: string | undefined): QueryGroup {
  return kind === "convenience" || kind === "bar" ? kind : "kiosk";
}

/** Overpass selectors per group. Spain also gets chinos (`shop=convenience`)
 *  and bars, from which `isChineseRunBar` picks Chinese-run ones by name
 *  here rather than with an Overpass name regex: that variant took ~160 s
 *  for Madrid and overpass-api.de rejected parts of it as invalid. */
function groupSelectors(region: Region): Array<[QueryGroup, string[]]> {
  const groups: Array<[QueryGroup, string[]]> = [
    ["kiosk", ['node["shop"="kiosk"]', 'node["shop"="beverages"]', 'way["shop"="kiosk"]', 'way["shop"="beverages"]']],
  ];
  if (region.iso3166_2.startsWith("ES")) {
    groups.push(["convenience", ['node["shop"="convenience"]["name"]', 'way["shop"="convenience"]["name"]']]);
    groups.push(["bar", ["bar", "cafe", "pub"].flatMap((v) => [`node["amenity"="${v}"]["name"]`, `way["amenity"="${v}"]["name"]`])]);
  }
  return groups;
}

function overpassQuery(region: Region, selectors: string[]): string {
  // Rest regions query by ISO area so the Bundesland envelope doesn't bleed
  // into neighbours. Cities stay on bbox: faster, well-tested, and the bbox
  // is already drawn tight around the urban area. iso3166_2 holds either a
  // subdivision code (DE-NW, AT-7) or a country code (CH) — dash presence
  // picks the Overpass area key.
  const [w, s, e, n] = region.bbox;
  if (region.role === "rest") {
    const iso = region.iso3166_2;
    const key = iso.includes("-") ? "ISO3166-2" : "ISO3166-1";
    // Optional bbox clip for territories with no ISO area of their own.
    const clip = region.bbox_clip ? `(${s},${w},${n},${e})` : "";
    return `[out:json][timeout:${QUERY_TIMEOUT_S}];
area["${key}"="${iso}"]->.a;
(
${selectors.map((sel) => `  ${sel}(area.a)${clip};`).join("\n")}
);
out center tags;`;
  }
  const box = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];
(
${selectors.map((sel) => `  ${sel}${box};`).join("\n")}
);
out center tags;`;
}

/** An answer missing more than this share of `expectedIds` is treated as a
 *  failed attempt and retried on the next endpoint. */
const MAX_MISSING_SHARE = 0.2;
const MIN_EXPECTED_FOR_CHECK = 10;

function missingShare(elements: OverpassElement[], expectedIds: Set<string>): number {
  if (expectedIds.size < MIN_EXPECTED_FOR_CHECK) return 0;
  const got = new Set(elements.map((el) => `${el.type}/${el.id}`));
  let missing = 0;
  for (const id of expectedIds) if (!got.has(id)) missing++;
  return missing / expectedIds.size;
}

/** POST `query` to the Overpass endpoints in rotation until one returns JSON
 *  that `check` accepts (`check` returns a rejection reason or null). */
async function overpass(
  query: string,
  check: (r: OverpassResponse) => string | null = () => null,
): Promise<OverpassResponse> {
  const body = `data=${encodeURIComponent(query)}`;
  const errors: string[] = [];
  const backoff = [5_000, 15_000, 30_000];
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    const idx = (preferredEndpoint + attempt) % OVERPASS_ENDPOINTS.length;
    const endpoint = OVERPASS_ENDPOINTS[idx]!;
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (resp.ok) {
        // Overpass reports runtime errors (e.g. "Dispatcher_Client timeout")
        // as HTML with status 200, so a parse failure counts as a failed try.
        const parsed = (await resp.json()) as OverpassResponse;
        const rejected = check(parsed);
        if (rejected === null) {
          preferredEndpoint = idx;
          return parsed;
        }
        errors.push(`${new URL(endpoint).host}: ${rejected}`);
      } else if (resp.status < 500 && resp.status !== 429) {
        throw new Error(`Overpass ${endpoint} returned HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
      } else {
        errors.push(`${new URL(endpoint).host}: HTTP ${resp.status}`);
      }
    } catch (err) {
      if ((err as Error).message.startsWith("Overpass ")) throw err;
      errors.push(`${new URL(endpoint).host}: ${(err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message}`);
    }
    if (attempt < backoff.length) {
      await new Promise((r) => setTimeout(r, backoff[attempt]!));
    }
  }
  throw new Error(`Overpass failed after retries: ${errors.join("; ")}`);
}

/** Would `fetchOsmForRegion` import this element (coordinates aside)? */
function isWanted(region: Region, el: OverpassElement): boolean {
  const tags = el.tags ?? {};
  if (!tags["name"]) return false;
  const spain = region.iso3166_2.startsWith("ES");
  if (spain && tags["shop"] === "convenience") return isChino(tags);
  if (spain && /^(bar|cafe|pub)$/.test(tags["amenity"] ?? "")) return isChineseRunBar(tags);
  if (tags["shop"] !== "kiosk" && tags["shop"] !== "beverages") return false;
  // Beverage-market chains (REWE/Edeka/Fristo/Trinkgut…) and obvious
  // Getränkemärkte arrive via the shop=beverages branch but aren't
  // Trinkhallen. Skip them at the source: existing OSM-only copies then
  // fall out as osm_removed on the next scrape.
  if (isNonKioskBeverageMarket(tags)) return false;
  if (spain && isSpanishNonDrinkKiosk(tags)) return false;
  return true;
}

/** `expectedIds`: OSM ids (`node/123`) the region file holds as live, per
 *  group. Mirrors with a stale or half-built area index answer with HTTP 200
 *  and a partial list (private.coffee: 0 of 105 for IT-BZ), so an answer
 *  missing most of them is retried on the next endpoint. Smaller gaps still
 *  slip through (a run lost 28 of ~1070 live Köln kiosks); `confirmRemoved`
 *  is what decides closures.
 *
 *  Only the kiosk group is required: it throws like a whole-region failure.
 *  A failed Spanish extra group is reported in `failedGroups` so the caller
 *  leaves that group's existing features untouched. */
export async function fetchOsmForRegion(
  region: Region,
  { expectedIds = new Map<QueryGroup, Set<string>>() }: { expectedIds?: Map<QueryGroup, Set<string>> } = {},
): Promise<{ features: OsmFeature[]; failedGroups: Map<QueryGroup, string> }> {
  const elements: OverpassElement[] = [];
  const failedGroups = new Map<QueryGroup, string>();
  for (const [group, selectors] of groupSelectors(region)) {
    const expected = expectedIds.get(group) ?? new Set<string>();
    try {
      const json = await overpass(overpassQuery(region, selectors), (r) => {
        const missing = missingShare(r.elements, expected);
        return missing > MAX_MISSING_SHARE
          ? `${Math.round(missing * 100)}% of ${expected.size} known elements missing`
          : null;
      });
      elements.push(...json.elements);
    } catch (err) {
      if (group === "kiosk") throw err;
      failedGroups.set(group, (err as Error).message);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const out: OsmFeature[] = [];

  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    if (!isWanted(region, el)) continue;
    const tags = el.tags!;
    const name = tags["name"]!;
    const sourceId = `${el.type === "node" ? "node" : "way"}/${el.id}`;
    const id = `tk_${region.prefix}_osm_${el.type[0]}${el.id}`;

    const feature: OsmFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id,
        name,
        address: stripUndefined({
          street: tags["addr:street"],
          number: tags["addr:housenumber"],
          postalcode: validPlz(tags["addr:postcode"]),
          city: tags["addr:city"],
          district: tags["addr:suburb"] ?? tags["addr:neighbourhood"],
        }),
        sources: [{ type: "osm", id: sourceId, version: el.version ?? 0 }],
        created: today,
        updated: today,
      },
    };

    const oh = cleanOpeningHours(tags["opening_hours"]);
    if (oh) {
      feature.properties.hours = { raw: oh };
    }

    const payment = mapPayment(tags);
    if (Object.keys(payment).length > 0) {
      feature.properties.payment = {
        cash: payment.cash ?? "unknown",
        cards: payment.cards ?? "unknown",
        contactless: payment.contactless ?? "unknown",
        girocard: payment.girocard ?? "unknown",
      };
    }

    const osmTags = mapTags(tags);
    if (osmTags.length > 0) feature.properties.tags = osmTags;

    const kind = detectKind(tags);
    if (kind) feature.properties.kind = kind;

    // Stamp provenance for every field this scrape actually populated.
    // Downstream writers consult `sources_by_field` to decide whether
    // their higher-rank data may overwrite ours.
    const paths: string[] = ["name"];
    const addr = feature.properties.address as Record<string, string>;
    for (const k of Object.keys(addr)) paths.push(`address.${k}`);
    if (feature.properties.hours) paths.push("hours");
    if (feature.properties.payment) {
      for (const k of Object.keys(feature.properties.payment)) paths.push(`payment.${k}`);
    }
    stampAll(feature.properties, paths, "osm");

    out.push(feature);
  }
  return { features: out, failedGroups };
}

/**
 * Of `ids` (OSM ids a region scrape didn't return), the ones that are really
 * gone: deleted, retagged, or now filtered out. Looked up by id rather than
 * by area, so a mirror's stale area index can't fake a closure; a partial
 * area answer that loses a few dozen live kiosks is otherwise
 * indistinguishable from real churn. Throws when no endpoint answers, so
 * the caller keeps the file instead of guessing.
 */
export async function confirmRemoved(region: Region, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const nodes = ids.filter((i) => i.startsWith("node/")).map((i) => i.slice(5));
  const ways = ids.filter((i) => i.startsWith("way/")).map((i) => i.slice(4));
  const query = `[out:json][timeout:${QUERY_TIMEOUT_S}];
(${nodes.length ? `node(id:${nodes.join(",")});` : ""}${ways.length ? `way(id:${ways.join(",")});` : ""});
out tags;`;
  const json = await overpass(query);
  const stillWanted = new Set(
    json.elements.filter((el) => isWanted(region, el)).map((el) => `${el.type}/${el.id}`),
  );
  return new Set(ids.filter((id) => !stillWanted.has(id)));
}

/**
 * Decide whether an OSM-tagged kiosk is actually something more specific
 * than a manned Späti. Conservative: only flag when the tags leave no
 * ambiguity. The downstream consumer (trinkhallen-app) filters vending
 * machines out of map/list views while keeping the underlying data
 * accessible to third parties, and labels the Spanish kinds.
 *
 * Catches automaten (vending machines) — JIMA, Sielaff, etc. — and the two
 * Spain-only categories pulled in by `spanishExtras`. Gas-station-attached
 * shops aren't flagged here because OSM tagging is inconsistent across
 * regions; the app does that one by operator/name.
 */
function detectKind(tags: Record<string, string>): OsmFeature["properties"]["kind"] {
  if (tags["amenity"] === "vending_machine") return "vending_machine";
  if (tags["self_service"] === "only") return "vending_machine";
  if (tags["automated"] === "yes") return "vending_machine";
  if (tags["shop"] === "convenience") return "convenience";
  if (/^(bar|cafe|pub)$/.test(tags["amenity"] ?? "")) return "bar";
  return undefined;
}

function normaliseEs(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * A "chino": the independent, late-open corner shop that sells cold beer.
 * In OSM it's an unbranded `shop=convenience`, but so are pet-food stores,
 * nutrition shops, Latin grocers and the like (a third of Madrid's unbranded
 * ones on the first scrape: "Piensos de la Vega", "Sport Nutrition", …).
 * So the name has to read like a corner shop (alimentación, bazar, chino,
 * autoservicio, mini/super market, 24h, …) or be a Chinese name, and must not
 * be a chain or a specialty grocer.
 */
const ES_CONVENIENCE_CHAIN =
  /\b(carrefour|supercor|dia|simply|sprint|repsol|shell|bp|cepsa|galp|circle k|avia|coviran|spar|alcampo|eroski|lidl|aldi|mercadona|corte ingles|opencor|open cor|udaco|suma|condis|bonarea|claudio|tangerina|sqrups|eneryeti|4eco|martin martin|hiper buenamente|trady)\b/;
const ES_CONVENIENCE_SPECIALTY =
  /\b(frutas|fruteria|verduras|verduleria|carniceria|panaderia|pescaderia|herbolario|latinos?|productos|gourmet|ecologic[ao]|organic|bio|halal|farmacia|estanco|nutrition|piensos|casqueria|embutidos)\b/;
const ES_CORNER_SHOP =
  /(\b(alimentacion|aliment|chin[oa]s?|autoservicio|tienda|ultramarinos|comestibles|colmado|super|supermercado|mercadito|asia|24 ?h|24 horas|open ?2[45]|express)\b|bazar\b|market\b)/;

export function isChino(tags: Record<string, string>): boolean {
  if (tags["brand"] || tags["brand:wikidata"]) return false;
  const name = tags["name"];
  if (!name) return false;
  for (const raw of [name, tags["operator"]]) {
    if (!raw) continue;
    const v = normaliseEs(raw);
    if (ES_CONVENIENCE_CHAIN.test(v) || ES_CONVENIENCE_SPECIALTY.test(v)) return false;
  }
  return ES_CORNER_SHOP.test(normaliseEs(name)) || isChineseName(name);
}

/**
 * Does a name point to Chinese owners? Chinese script, "chino/china" as a
 * word, or a common Chinese surname as a whole word. OSM has no "who runs
 * it" tag, so the name is all there is. `name:zh` is no signal (tourist
 * spots carry translations). Surnames that collide with Spanish, Catalan,
 * French or English words in real bar names are left out: pan, ma, sun,
 * song, cao, du, lu, fu, mao, tian ("Pan y Sal", "Your Song", "Café du
 * Parc", "Kung Fu"…). Misses are expected; the app's report flow fixes
 * individual places.
 */
const CHINESE_SURNAMES =
  "wang|zhang|chen|liu|huang|zhou|zhao|wu|xu|lin|yang|zheng|zhu|guo|luo|gao|xie|cai|dong|jiang|xin|li|jin|hong|ming|wen|xia|peng|" +
  "feng|deng|tang|han|shen|qian|fang|xiao|zeng|kong|bai|yan|wei|qiu|hu|ren|yu|ye";
const CHINESE_NAME = new RegExp(`(^|[^a-z])(chin[oa]s?|${CHINESE_SURNAMES})([^a-z]|$)`);
/** Non-Chinese names that contain a surname as a word. */
const CHINESE_NAME_FALSE = /\b(ye[ -]?ye|jin ?tonic|wu ?tang|martel ?li|china ?town|porcelana china|sushi|bocai)\b|·/;

function isChineseName(name: string): boolean {
  if (/[\u3400-\u9fff]/.test(name)) return true;
  const v = normaliseEs(name);
  if (CHINESE_NAME_FALSE.test(v)) return false;
  return CHINESE_NAME.test(v);
}

/** A "bar de chinos": a bar run by Chinese owners, judged by its name. */
export function isChineseRunBar(tags: Record<string, string>): boolean {
  const name = tags["name"];
  return !!name && isChineseName(name);
}

/**
 * A Getränkemarkt is not a Trinkhalle. shop=beverages catches both the
 * dedicated beverage chains and one-off bottle shops; this drops the ones
 * the user wouldn't recognise as a kiosk while leaving genuinely ambiguous
 * independents (a named Späti that happens to be tagged shop=beverages) in
 * place. Three signals, any one is enough:
 *   1. name/brand/operator reads as a beverage market ("… Getränkemarkt",
 *      "Getränkeland").
 *   2. it carries a known beverage-chain brand — covers branch names that
 *      don't spell out "Getränkemarkt" (a bare "Fristo" or "Trinkgut").
 *   3. it's a shop=beverages with a brand:wikidata, OSM's strongest "this is
 *      a chain entity, not an independent" signal.
 */
function normaliseChain(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BEVERAGE_MARKET_NAME = /getraenke ?markt|getraenkeland/;
const BEVERAGE_CHAIN_KEYWORDS = [
  "fristo",
  "trinkgut",
  "getraenke hoffmann",
  "dursty",
  "hol ab",
  "orterer",
  "trink und spare",
  "getraenke geins",
  "getraenke quelle",
];

export function isNonKioskBeverageMarket(tags: Record<string, string>): boolean {
  for (const raw of [tags["name"], tags["brand"], tags["operator"]]) {
    if (!raw) continue;
    const v = normaliseChain(raw);
    if (BEVERAGE_MARKET_NAME.test(v)) return true;
    if (BEVERAGE_CHAIN_KEYWORDS.some((k) => v.includes(k))) return true;
  }
  if (tags["shop"] === "beverages" && tags["brand:wikidata"]) return true;
  return false;
}

/**
 * In Spain shop=kiosk mostly means a newspaper stand, an ONCE lottery booth,
 * an estanco or a papelería/librería (stationery, books, comics), none of
 * which sell a cold beer. Drop the ones whose tags or name say so outright;
 * a bare "Kiosco"/"Quiosco" stays, since that is also what a drinks kiosk in
 * a park is called.
 */
const ES_NON_DRINK_NAME =
  /\b(prensa|premsa|revistas?|periodicos?|loterias?|apuestas|estanco|tabacs?|tabacos?|papeleria|papereria|libreria|llibreria|libros|llibres|comics?|cromos)\b/;

export function isSpanishNonDrinkKiosk(tags: Record<string, string>): boolean {
  if (tags["lottery"] && tags["lottery"] !== "no") return true;
  for (const raw of [tags["name"], tags["brand"], tags["operator"]]) {
    if (!raw) continue;
    // "once" is also the Spanish word for eleven; only the blind-people's
    // lottery spells it in capitals or stands alone as the whole name.
    if (/\bONCE\b/.test(raw)) return true;
    const v = raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (v.trim() === "once") return true;
    if (ES_NON_DRINK_NAME.test(v)) return true;
  }
  return false;
}

function validPlz(s: string | undefined): string | undefined {
  return s && /^\d{5}$/.test(s) ? s : undefined;
}

function mapPayment(tags: Record<string, string>): Partial<Record<"cash" | "cards" | "contactless" | "girocard", "yes" | "no" | "unknown">> {
  const tri = (v: string | undefined): "yes" | "no" | "unknown" | undefined => {
    if (v === undefined) return undefined;
    if (v === "yes" || v === "only") return "yes";
    if (v === "no") return "no";
    return "unknown";
  };
  const out: Partial<Record<"cash" | "cards" | "contactless" | "girocard", "yes" | "no" | "unknown">> = {};
  const cash = tri(tags["payment:cash"]);
  if (cash) out.cash = cash;
  const credit = tri(tags["payment:credit_cards"]);
  const debit = tri(tags["payment:debit_cards"]);
  // Cards = any of credit or debit yes
  if (credit === "yes" || debit === "yes") out.cards = "yes";
  else if (credit === "no" && debit === "no") out.cards = "no";
  else if (credit || debit) out.cards = "unknown";
  const contactless = tri(tags["payment:contactless"]);
  if (contactless) out.contactless = contactless;
  const girocard = tri(tags["payment:girocard"] ?? tags["payment:ec_cards"]);
  if (girocard) out.girocard = girocard;
  // Apple/Google Pay implies a contactless terminal — fold into contactless
  // rather than emitting a separate (removed) mobile key.
  const apple = tri(tags["payment:apple_pay"]);
  const google = tri(tags["payment:google_pay"]);
  if (apple === "yes" || google === "yes") out.contactless = "yes";
  return out;
}

function mapTags(tags: Record<string, string>): string[] {
  const out: string[] = [];
  if (tags["toilets"] === "yes") out.push("wc");
  if (tags["wheelchair"] === "yes") out.push("barrierefrei");
  if (tags["outdoor_seating"] === "yes") out.push("draussen");
  if (tags["indoor_seating"] === "yes" || tags["seating"] === "yes") out.push("sitzgelegenheiten");
  if (tags["smoking"] === "yes" || tags["smoking"] === "outside") out.push("raucherbereich");
  if (tags["covered"] === "yes") out.push("ueberdacht");
  if (tags["vending"] === "drinks" || tags["vending"] === "beverages") out.push("automat");
  return out;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// CLI entry-point
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: tsx scripts/osm-to-geojson.ts <region-slug>");
    process.exit(2);
  }
  const regions = await loadRegions();
  const region = regions.find((r) => r.slug === slug);
  if (!region) {
    console.error(`Region ${slug} not in regions.yml`);
    process.exit(2);
  }
  const { features, failedGroups } = await fetchOsmForRegion(region);
  for (const [group, msg] of failedGroups) console.error(`${group} group failed: ${msg}`);
  process.stdout.write(
    JSON.stringify({ type: "FeatureCollection", features }, null, 2) + "\n",
  );
}
