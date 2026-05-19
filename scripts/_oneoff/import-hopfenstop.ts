/**
 * One-shot importer: hopfenstop/kiosk_data.json → data/de/hessen/frankfurt.geojson
 *
 * Run this once at bootstrap; the result is committed and the script is archived.
 * Re-running it would clobber later edits — there is a `--force` flag in case
 * we need to regenerate from a clean slate.
 *
 * Output:
 *   - GeoJSON FeatureCollection
 *   - Each feature normalized to our schema (schema/kiosk.schema.json)
 *   - `properties.sources` carries `{type:"hopfenstop", id:<original kioskId>}`
 *   - Tags slugified to the controlled vocabulary; unknown tags warned + dropped
 *   - `[hour, minute]` arrays merged into an OSM `opening_hours` string
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SOURCE_URL =
  "https://raw.githubusercontent.com/hopfenstop/hopfenstop.github.io/master/src/data/kiosk_data.json";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OUTPUT_PATH = resolve(REPO_ROOT, "data/de/hessen/frankfurt.geojson");
const SCHEMA_PATH = resolve(REPO_ROOT, "schema/kiosk.schema.json");
const TAGS_PATH = resolve(REPO_ROOT, "schema/tags.json");

// --- types in the hopfenstop upstream shape -------------------------------

interface HopfenstopAddress {
  street?: string;
  number?: string;
  city?: string;
  postalcode?: string;
  district?: string;
  geolat: string;
  geolng: string;
}

interface HopfenstopTime {
  day: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
  openTime: [number, number];
  closeTime: [number, number];
}

interface HopfenstopTagVote {
  tag: string;
  tagVotes?: { totalVotes?: number };
}

interface HopfenstopKiosk {
  kioskId: string;
  name: string;
  description?: string;
  address: HopfenstopAddress;
  kioskTimes?: HopfenstopTime[];
  kioskTags?: HopfenstopTagVote[];
}

// --- our schema target ----------------------------------------------------

type TriState = "yes" | "no" | "unknown";

interface KioskFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address: {
      street?: string;
      number?: string;
      postalcode?: string;
      city?: string;
      district?: string;
    };
    hours?: { raw: string };
    tags?: string[];
    payment?: Record<"cash" | "cards" | "contactless" | "girocard" | "mobile", TriState>;
    sources?: Array<{ type: string; id: string; version?: number }>;
    created: string;
    updated: string;
  };
}

// --- transforms -----------------------------------------------------------

const DAY_TO_OSM: Record<HopfenstopTime["day"], string> = {
  MONDAY: "Mo",
  TUESDAY: "Tu",
  WEDNESDAY: "We",
  THURSDAY: "Th",
  FRIDAY: "Fr",
  SATURDAY: "Sa",
  SUNDAY: "Su",
};
const OSM_DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Convert hopfenstop's `kioskTimes` array into an OSM `opening_hours` string.
 * Collapses contiguous identical days into ranges (Mo-Fr 09:00-22:00).
 */
function toOpeningHours(times: HopfenstopTime[]): string | undefined {
  if (!times || times.length === 0) return undefined;

  // Map day → "HH:MM-HH:MM" (one slot per day; upstream data only has one)
  const slotByDay = new Map<string, string>();
  for (const t of times) {
    if (!Array.isArray(t.openTime) || !Array.isArray(t.closeTime)) continue;
    const [oh = 0, om = 0] = t.openTime;
    const [ch = 0, cm = 0] = t.closeTime;
    const osmDay = DAY_TO_OSM[t.day];
    if (!osmDay) continue;
    slotByDay.set(osmDay, `${pad(oh)}:${pad(om)}-${pad(ch)}:${pad(cm)}`);
  }
  if (slotByDay.size === 0) return undefined;

  // Group contiguous days with the same slot.
  type Group = { days: string[]; slot: string };
  const groups: Group[] = [];
  for (const day of OSM_DAY_ORDER) {
    const slot = slotByDay.get(day);
    if (!slot) continue;
    const last = groups[groups.length - 1];
    if (last && last.slot === slot && isContiguous(last.days, day)) {
      last.days.push(day);
    } else {
      groups.push({ days: [day], slot });
    }
  }

  return groups
    .map(({ days, slot }) => {
      const first = days[0]!;
      const last = days[days.length - 1]!;
      const dayPart = first === last ? first : `${first}-${last}`;
      return `${dayPart} ${slot}`;
    })
    .join("; ");
}

function isContiguous(group: string[], next: string): boolean {
  const lastDay = group[group.length - 1];
  if (!lastDay) return false;
  const lastIdx = OSM_DAY_ORDER.indexOf(lastDay as (typeof OSM_DAY_ORDER)[number]);
  const nextIdx = OSM_DAY_ORDER.indexOf(next as (typeof OSM_DAY_ORDER)[number]);
  return nextIdx === lastIdx + 1;
}

/**
 * Slugify a free-form German tag string to our controlled vocabulary.
 * Returns null when the tag has no canonical slug — the caller decides whether
 * to drop or warn.
 */
function slugifyTag(raw: string, vocab: Record<string, { de: string }>): string | null {
  const normalized = raw
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized in vocab) return normalized;

  // Match by German display label
  for (const [slug, entry] of Object.entries(vocab)) {
    if (slug.startsWith("$")) continue;
    const labelNorm = entry.de
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (labelNorm === normalized) return slug;
  }

  return null;
}

function parseCoord(s: string): number | undefined {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

// --- main -----------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if ((await exists(OUTPUT_PATH)) && !force) {
    console.error(`Refusing to overwrite ${OUTPUT_PATH} (pass --force to override).`);
    process.exit(1);
  }

  const vocab = JSON.parse(await readFile(TAGS_PATH, "utf8")) as Record<
    string,
    { de: string; group?: string }
  >;

  console.log(`Fetching ${SOURCE_URL} …`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const raw = (await resp.json()) as HopfenstopKiosk[];
  console.log(`Got ${raw.length} kiosks.`);

  const today = new Date().toISOString().slice(0, 10);
  const unknownTags = new Map<string, number>();
  const features: KioskFeature[] = [];

  let skipped = 0;
  for (let i = 0; i < raw.length; i++) {
    const k = raw[i]!;
    const lng = parseCoord(k.address.geolng);
    const lat = parseCoord(k.address.geolat);
    if (lng === undefined || lat === undefined) {
      skipped++;
      continue;
    }

    const tags: string[] = [];
    for (const t of k.kioskTags ?? []) {
      if (!t?.tag) continue;
      // Skip negative-vote tags (community said "no, this isn't true").
      if ((t.tagVotes?.totalVotes ?? 0) < 0) continue;
      const slug = slugifyTag(t.tag, vocab);
      if (slug) {
        if (!tags.includes(slug)) tags.push(slug);
      } else {
        unknownTags.set(t.tag, (unknownTags.get(t.tag) ?? 0) + 1);
      }
    }

    const id = `tk_fr_${(i + 1).toString().padStart(4, "0")}`;
    const feature: KioskFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        id,
        name: k.name,
        ...(k.description ? { description: k.description } : {}),
        address: stripUndefined({
          street: asString(k.address.street),
          number: asString(k.address.number),
          postalcode: asPostalcode(k.address.postalcode),
          city: asString(k.address.city),
          district: asString(k.address.district),
        }),
        ...(k.kioskTimes ? withMaybe("hours", toOpeningHours(k.kioskTimes), (raw) => ({ raw })) : {}),
        ...(tags.length ? { tags } : {}),
        sources: [{ type: "hopfenstop", id: k.kioskId }],
        created: today,
        updated: today,
      },
    };

    features.push(feature);
  }

  // Validate every feature against the schema before writing.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const validate = ajv.compile(schema);
  let invalid = 0;
  for (const f of features) {
    if (!validate(f)) {
      invalid++;
      if (invalid <= 5) {
        console.warn(`Invalid feature ${f.properties.id}:`, validate.errors);
      }
    }
  }
  if (invalid > 0) {
    throw new Error(`${invalid} features failed schema validation. Aborting write.`);
  }

  const collection = { type: "FeatureCollection" as const, features };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(collection, null, 2) + "\n", "utf8");

  console.log(`Wrote ${features.length} features → ${OUTPUT_PATH}`);
  console.log(`Skipped ${skipped} features (missing coords).`);
  if (unknownTags.size > 0) {
    console.log(`Unknown tags (consider extending schema/tags.json):`);
    [...unknownTags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .forEach(([t, n]) => console.log(`  ${n.toString().padStart(4)}× ${t}`));
  }
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Coerce upstream values that are sometimes `null` or `number` into clean strings or undefined. */
function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Only keep postalcodes that are exactly 5 digits; drop the rest as dirty. */
function asPostalcode(v: unknown): string | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  return /^\d{5}$/.test(s) ? s : undefined;
}

function withMaybe<K extends string, T, U>(
  key: K,
  value: T | undefined,
  wrap: (t: T) => U,
): Partial<Record<K, U>> {
  return value === undefined ? {} : ({ [key]: wrap(value) } as Partial<Record<K, U>>);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
