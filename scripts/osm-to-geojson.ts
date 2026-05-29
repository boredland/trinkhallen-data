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
    kind?: "vending_machine";
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

const OVERPASS_ENDPOINT = process.env["OVERPASS_ENDPOINT"] ?? "https://overpass-api.de/api/interpreter";
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

function overpassQuery(region: Region): string {
  // Rest regions query by ISO area so the Bundesland envelope doesn't bleed
  // into neighbours. Cities stay on bbox: faster, well-tested, and the bbox
  // is already drawn tight around the urban area. iso3166_2 holds either a
  // subdivision code (DE-NW, AT-7) or a country code (CH) — dash presence
  // picks the Overpass area key.
  if (region.role === "rest") {
    const iso = region.iso3166_2;
    const key = iso.includes("-") ? "ISO3166-2" : "ISO3166-1";
    // Optional bbox clip for territories with no ISO area of their own.
    const [w, s, e, n] = region.bbox;
    const clip = region.bbox_clip ? `(${s},${w},${n},${e})` : "";
    return `[out:json][timeout:300];
area["${key}"="${iso}"]->.a;
(
  node["shop"="kiosk"](area.a)${clip};
  node["shop"="beverages"](area.a)${clip};
  way["shop"="kiosk"](area.a)${clip};
  way["shop"="beverages"](area.a)${clip};
);
out center tags;`;
  }
  const [w, s, e, n] = region.bbox;
  return `[out:json][timeout:180];
(
  node["shop"="kiosk"](${s},${w},${n},${e});
  node["shop"="beverages"](${s},${w},${n},${e});
  way["shop"="kiosk"](${s},${w},${n},${e});
  way["shop"="beverages"](${s},${w},${n},${e});
);
out center tags;`;
}

export async function fetchOsmForRegion(region: Region): Promise<OsmFeature[]> {
  const body = `data=${encodeURIComponent(overpassQuery(region))}`;

  // Retry on 5xx + 429 with exponential backoff. Overpass is volunteer-run and
  // periodically returns 504 under load; a single transient failure used to
  // crash the whole weekly scrape (see run 26167365806 — aachen 504).
  let resp: Response | null = null;
  let lastErr: unknown = null;
  const backoff = [2_000, 5_000, 12_000, 30_000, 60_000];
  for (let attempt = 0; attempt < backoff.length; attempt++) {
    try {
      resp = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body,
      });
      if (resp.ok) break;
      if (resp.status < 500 && resp.status !== 429) {
        throw new Error(`Overpass ${OVERPASS_ENDPOINT} returned HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < backoff.length - 1) {
      await new Promise((r) => setTimeout(r, backoff[attempt]!));
    }
  }
  if (!resp || !resp.ok) {
    throw new Error(`Overpass ${OVERPASS_ENDPOINT} failed after retries: ${(lastErr as Error)?.message ?? "unknown"}`);
  }
  const json = (await resp.json()) as OverpassResponse;
  const today = new Date().toISOString().slice(0, 10);
  const out: OsmFeature[] = [];

  for (const el of json.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const tags = el.tags ?? {};
    const name = tags["name"];
    if (!name) continue;
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
  return out;
}

/**
 * Decide whether an OSM-tagged kiosk is actually something more specific
 * than a manned Späti. Conservative: only flag when the tags leave no
 * ambiguity. The downstream consumer (trinkhallen-app) filters these out
 * of map/list views while keeping the underlying data accessible to third
 * parties.
 *
 * Currently catches automaten (vending machines) — JIMA, Sielaff, etc.
 * Gas-station-attached shops aren't flagged here because OSM tagging is
 * inconsistent across regions; the app does that one by operator/name.
 */
function detectKind(tags: Record<string, string>): "vending_machine" | undefined {
  if (tags["amenity"] === "vending_machine") return "vending_machine";
  if (tags["self_service"] === "only") return "vending_machine";
  if (tags["automated"] === "yes") return "vending_machine";
  return undefined;
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
  const features = await fetchOsmForRegion(region);
  process.stdout.write(
    JSON.stringify({ type: "FeatureCollection", features }, null, 2) + "\n",
  );
}
