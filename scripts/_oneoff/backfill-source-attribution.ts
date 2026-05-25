/**
 * One-shot: backfill `properties.sources_by_field` for existing features
 * whose data predates per-field source tracking.
 *
 * Strategy: pull the current Hopfenstop upstream (the same JSON that
 * import-hopfenstop.ts seeded from), and for every feature in the dataset
 * that carries a `hopfenstop` source, compare each field value against
 * what Hopfenstop's record holds.
 *
 *   - name, description: string-compare → stamp `hopfenstop` on match.
 *   - address sub-keys (street/number/postalcode/city/district): per-key
 *     string-compare.
 *   - hours.raw: convert Hopfenstop's `kioskTimes` to OSM opening_hours
 *     and string-compare.
 *
 * Fields where the current value differs from Hopfenstop (or where
 * Hopfenstop has nothing) are left unstamped — the default `osm`-tier
 * rank in `lib/sources.ts` covers those, which matches reality: anything
 * not from Hopfenstop almost always came from the OSM scrape.
 *
 * Payment is never in Hopfenstop, so we never stamp it here. Tags are a
 * union (no precedence) and are intentionally skipped.
 *
 * Run:
 *   bun scripts/_oneoff/backfill-source-attribution.ts --dry-run
 *   bun scripts/_oneoff/backfill-source-attribution.ts
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SOURCE_URL =
  "https://raw.githubusercontent.com/hopfenstop/hopfenstop.github.io/master/src/data/kiosk_data.json";

const DRY_RUN = process.argv.includes("--dry-run");

interface HopfenstopAddress {
  street?: string;
  number?: string;
  city?: string;
  postalcode?: string;
  district?: string;
}
interface HopfenstopTime {
  day: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
  openTime: [number, number];
  closeTime: [number, number];
}
interface HopfenstopKiosk {
  kioskId: string;
  name: string;
  description?: string;
  address: HopfenstopAddress & { geolat?: string; geolng?: string };
  kioskTimes?: HopfenstopTime[];
}

interface Feature {
  type: "Feature";
  properties: {
    id: string;
    name?: string;
    description?: string;
    address?: Record<string, string | undefined>;
    hours?: { raw?: string };
    sources?: Array<{ type: string; id: string }>;
    sources_by_field?: Record<string, string>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

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
const pad = (n: number): string => n.toString().padStart(2, "0");

function isContiguous(group: string[], next: string): boolean {
  const lastDay = group[group.length - 1];
  if (!lastDay) return false;
  const lastIdx = OSM_DAY_ORDER.indexOf(lastDay as (typeof OSM_DAY_ORDER)[number]);
  const nextIdx = OSM_DAY_ORDER.indexOf(next as (typeof OSM_DAY_ORDER)[number]);
  return nextIdx === lastIdx + 1;
}

/** Copy of import-hopfenstop.ts:toOpeningHours so we can reproduce the
 *  exact opening_hours string that ended up in the seed feature. */
function toOpeningHours(times: HopfenstopTime[] | undefined): string | undefined {
  if (!times || times.length === 0) return undefined;
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

function hopId(f: Feature): string | null {
  return f.properties.sources?.find((s) => s.type === "hopfenstop")?.id ?? null;
}

interface PerFileStats {
  file: string;
  features_visited: number;
  hopfenstop_features: number;
  stamped_total: number;
  by_path: Record<string, number>;
}

async function walkGeojsonFiles(): Promise<string[]> {
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
  return out.sort();
}

function bump(stats: PerFileStats, path: string): void {
  stats.stamped_total++;
  stats.by_path[path] = (stats.by_path[path] ?? 0) + 1;
}

function attributeOne(f: Feature, h: HopfenstopKiosk, stats: PerFileStats): boolean {
  const sbf = f.properties.sources_by_field ?? (f.properties.sources_by_field = {});
  let touched = false;

  const stampIfMatch = (path: string, ours: unknown, theirs: unknown): void => {
    if (sbf[path]) return; // already attributed
    if (ours === undefined || ours === null || ours === "") return;
    if (theirs === undefined || theirs === null || theirs === "") return;
    if (ours !== theirs) return;
    sbf[path] = "hopfenstop";
    bump(stats, path);
    touched = true;
  };

  stampIfMatch("name", f.properties.name, h.name);
  stampIfMatch("description", f.properties.description, h.description);

  const addr = f.properties.address ?? {};
  stampIfMatch("address.street", addr["street"], h.address.street);
  stampIfMatch("address.number", addr["number"], h.address.number);
  stampIfMatch("address.postalcode", addr["postalcode"], h.address.postalcode);
  stampIfMatch("address.city", addr["city"], h.address.city);
  stampIfMatch("address.district", addr["district"], h.address.district);

  const hopHours = toOpeningHours(h.kioskTimes);
  stampIfMatch("hours", f.properties.hours?.raw, hopHours);

  return touched;
}

async function main(): Promise<void> {
  console.error(`Fetching ${SOURCE_URL} …`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const upstream = (await resp.json()) as HopfenstopKiosk[];
  const byId = new Map<string, HopfenstopKiosk>();
  for (const k of upstream) byId.set(k.kioskId, k);
  console.error(`Indexed ${byId.size} Hopfenstop records.`);

  const files = await walkGeojsonFiles();
  const allStats: PerFileStats[] = [];

  for (const file of files) {
    const doc = JSON.parse(await readFile(file, "utf8")) as { features: Feature[] };
    const stats: PerFileStats = {
      file: file.replace(`${REPO_ROOT}/`, ""),
      features_visited: doc.features.length,
      hopfenstop_features: 0,
      stamped_total: 0,
      by_path: {},
    };
    let dirty = false;
    for (const f of doc.features) {
      const id = hopId(f);
      if (!id) continue;
      stats.hopfenstop_features++;
      const h = byId.get(id);
      if (!h) continue; // hopfenstop removed this record upstream; skip
      if (attributeOne(f, h, stats)) dirty = true;
    }
    if (dirty && !DRY_RUN) {
      await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
    }
    allStats.push(stats);
  }

  const totals = allStats.reduce(
    (acc, s) => ({
      files: acc.files + 1,
      files_touched: acc.files_touched + (s.stamped_total > 0 ? 1 : 0),
      hopfenstop_features: acc.hopfenstop_features + s.hopfenstop_features,
      stamped_total: acc.stamped_total + s.stamped_total,
      by_path: {
        ...acc.by_path,
        ...Object.fromEntries(
          Object.entries(s.by_path).map(([k, v]) => [k, (acc.by_path[k] ?? 0) + v]),
        ),
      },
    }),
    {
      files: 0,
      files_touched: 0,
      hopfenstop_features: 0,
      stamped_total: 0,
      by_path: {} as Record<string, number>,
    },
  );

  process.stdout.write(JSON.stringify({ dry_run: DRY_RUN, totals }, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
