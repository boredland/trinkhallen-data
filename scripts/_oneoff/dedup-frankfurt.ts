/**
 * One-shot: dedupe Hopfenstop ↔ OSM features in Frankfurt.
 *
 * Background. The Hopfenstop seed (one-shot, see _oneoff/import-hopfenstop.ts)
 * imported ~750 hand-curated Frankfurt kiosks. The subsequent OSM scrape
 * pulled in everything Overpass returned — 1.2k+ features — without a join
 * step. 199 features ended up with both sources (the importer dedup'd what
 * it could), but 551 hopfenstop-only + 985 osm-only remain, with significant
 * physical overlap between them.
 *
 * Strategy (Tier A, auto-merge):
 *   Pair a hopfenstop-only feature with an osm-only neighbour when:
 *     - haversine ≤ 30m, AND
 *     - (dice(name) ≥ 0.55  OR  one name is substring of the other (≥3 chars)
 *        OR  same street + number)
 *   Merge: keep the OSM feature (preserves the upstream node/id reference),
 *   conservatively fill blanks from Hopfenstop (payment "unknown" → known,
 *   missing hours/address/tags), union sources[], pick the more descriptive
 *   name, delete the Hopfenstop-only feature.
 *
 * Tier B (manual review):
 *   Pairs with haversine ≤ 30m and dice 0.3–0.55 that didn't make Tier A
 *   land in _dedup-review.csv. No data is changed for these.
 *
 * Run:
 *   bun scripts/_oneoff/dedup-frankfurt.ts --dry-run    # report only
 *   bun scripts/_oneoff/dedup-frankfurt.ts              # write changes
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Source {
  type: string;
  id?: string;
  version?: number;
}

interface Payment {
  cash?: string;
  cards?: string;
  contactless?: string;
  girocard?: string;
  mobile?: string;
  [k: string]: string | undefined;
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address: Record<string, string>;
    hours?: { raw: string };
    tags?: string[];
    payment?: Payment;
    sources?: Source[];
    created?: string;
    updated?: string;
    [k: string]: unknown;
  };
}

const FILE = "data/de/hessen/frankfurt.geojson";
const DRY_RUN = process.argv.includes("--dry-run");

const doc = JSON.parse(readFileSync(FILE, "utf8")) as {
  type: "FeatureCollection";
  features: Feature[];
};

function hasSrc(f: Feature, t: string): boolean {
  return f.properties.sources?.some((s) => s.type === t) ?? false;
}

function dist(a: Feature, b: Feature): number {
  const [lng1, lat1] = a.geometry.coordinates;
  const [lng2, lat2] = b.geometry.coordinates;
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const padded = `  ${s}  `;
  const set = new Set<string>();
  for (let i = 0; i < padded.length - 1; i++) set.add(padded.slice(i, i + 2));
  return set;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function isSubstring(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

function sameAddress(a: Feature, b: Feature): boolean {
  const as = (a.properties.address["street"] ?? "").trim().toLowerCase();
  const an = (a.properties.address["number"] ?? "").trim().toLowerCase();
  const bs = (b.properties.address["street"] ?? "").trim().toLowerCase();
  const bn = (b.properties.address["number"] ?? "").trim().toLowerCase();
  if (!as || !an || !bs || !bn) return false;
  return as === bs && an === bn;
}

// Hopfenstop names tend to be richer ("Trinkhalle Berger Straße") than OSM's
// generic "Trinkhalle". Prefer the longer name unless one is just a noisy
// suffix of the other. If lengths are within 4 chars, keep OSM's (canonical
// upstream identifier wins ties).
function pickName(osmName: string, hopsName: string): string {
  const o = osmName.trim();
  const h = hopsName.trim();
  if (!o) return h;
  if (!h) return o;
  if (Math.abs(o.length - h.length) <= 4) return o;
  return h.length > o.length ? h : o;
}

function mergeFeature(osmF: Feature, hopsF: Feature): {
  changed_keys: string[];
  added_keys: string[];
} {
  const changed: string[] = [];
  const added: string[] = [];

  // Name: pick the more descriptive
  const newName = pickName(osmF.properties.name, hopsF.properties.name);
  if (newName !== osmF.properties.name) {
    osmF.properties.name = newName;
    changed.push("name");
  }

  // Description: OSM rarely has one; only set if missing
  if (!osmF.properties.description && hopsF.properties.description) {
    osmF.properties.description = hopsF.properties.description;
    added.push("description");
  }

  // Payment: fill unknowns
  if (hopsF.properties.payment) {
    const cur = osmF.properties.payment ?? {};
    const next: Payment = { ...cur };
    let touched = false;
    for (const [k, v] of Object.entries(hopsF.properties.payment)) {
      if (v && v !== "unknown" && (!cur[k] || cur[k] === "unknown")) {
        next[k] = v;
        touched = true;
      }
    }
    if (touched) {
      osmF.properties.payment = next;
      added.push("payment");
    }
  }

  // Hours: only if OSM has nothing
  if (!osmF.properties.hours?.raw && hopsF.properties.hours?.raw) {
    osmF.properties.hours = { raw: hopsF.properties.hours.raw };
    added.push("hours");
  }

  // Address: fill empty fields
  const a = osmF.properties.address ?? {};
  const b = hopsF.properties.address ?? {};
  let addrTouched = false;
  for (const [k, v] of Object.entries(b)) {
    if (!a[k] && v) {
      a[k] = v;
      addrTouched = true;
    }
  }
  if (addrTouched) {
    osmF.properties.address = a;
    added.push("address");
  }

  // Tags: union
  const tagSet = new Set(osmF.properties.tags ?? []);
  const before = tagSet.size;
  for (const t of hopsF.properties.tags ?? []) tagSet.add(t);
  if (tagSet.size > before) {
    osmF.properties.tags = [...tagSet].sort();
    added.push(`tags(+${tagSet.size - before})`);
  }

  // Sources: union — entries are dedup'd by (type, id)
  const sources = osmF.properties.sources ?? [];
  const seen = new Set(sources.map((s) => `${s.type}::${s.id ?? ""}`));
  for (const s of hopsF.properties.sources ?? []) {
    const key = `${s.type}::${s.id ?? ""}`;
    if (!seen.has(key)) {
      sources.push(s);
      seen.add(key);
    }
  }
  osmF.properties.sources = sources;

  // Bump the updated stamp since we merged data
  osmF.properties.updated = new Date().toISOString().slice(0, 10);

  return { changed_keys: changed, added_keys: added };
}

// Pair up. For each hops-only feature, find the closest osm-only feature
// within 30m that also passes the name/address heuristic.
const hopsOnly = doc.features.filter((f) => hasSrc(f, "hopfenstop") && !hasSrc(f, "osm"));
const osmOnly = doc.features.filter((f) => !hasSrc(f, "hopfenstop") && hasSrc(f, "osm"));

interface Pair {
  hops: Feature;
  osm: Feature;
  meters: number;
  sim: number;
  reason: string;
}

const tierA: Pair[] = [];
const tierB: Pair[] = [];
const claimedOsm = new Set<string>();

// Score every potential pair, then pick best non-conflicting matches.
const allPairs: Pair[] = [];
for (const h of hopsOnly) {
  const hNorm = norm(h.properties.name);
  for (const o of osmOnly) {
    const m = dist(h, o);
    if (m > 30) continue;
    const oNorm = norm(o.properties.name);
    const sim = dice(hNorm, oNorm);
    const sub = isSubstring(hNorm, oNorm);
    const addr = sameAddress(h, o);
    let reason = "";
    if (sim >= 0.55) reason = `dice=${sim.toFixed(2)}`;
    else if (sub) reason = `substring`;
    else if (addr) reason = `address`;
    if (reason) allPairs.push({ hops: h, osm: o, meters: m, sim, reason });
    else if (sim >= 0.3) {
      allPairs.push({ hops: h, osm: o, meters: m, sim, reason: `B:dice=${sim.toFixed(2)}` });
    }
  }
}

// Greedy assignment: sort by (Tier A first, then by sim desc, distance asc),
// claim each OSM target at most once.
allPairs.sort((a, b) => {
  const aA = !a.reason.startsWith("B:");
  const bA = !b.reason.startsWith("B:");
  if (aA !== bA) return aA ? -1 : 1;
  if (b.sim !== a.sim) return b.sim - a.sim;
  return a.meters - b.meters;
});

const claimedHops = new Set<string>();
for (const p of allPairs) {
  if (claimedOsm.has(p.osm.properties.id)) continue;
  if (claimedHops.has(p.hops.properties.id)) continue;
  claimedOsm.add(p.osm.properties.id);
  claimedHops.add(p.hops.properties.id);
  if (p.reason.startsWith("B:")) tierB.push(p);
  else tierA.push(p);
}

// Execute Tier A merges.
const mergeResults: Array<{
  osm_id: string;
  hops_id: string;
  osm_name: string;
  hops_name: string;
  meters: number;
  sim: number;
  reason: string;
  changed_keys: string[];
  added_keys: string[];
}> = [];

const toDelete = new Set<string>();
for (const p of tierA) {
  const merge = mergeFeature(p.osm, p.hops);
  toDelete.add(p.hops.properties.id);
  mergeResults.push({
    osm_id: p.osm.properties.id,
    hops_id: p.hops.properties.id,
    osm_name: p.osm.properties.name,
    hops_name: p.hops.properties.name,
    meters: Math.round(p.meters * 10) / 10,
    sim: Math.round(p.sim * 100) / 100,
    reason: p.reason,
    ...merge,
  });
}

doc.features = doc.features.filter((f) => !toDelete.has(f.properties.id));

// Write Tier B review CSV regardless of dry-run flag.
const csv = [
  "hops_id,osm_id,meters,sim,hops_name,osm_name,hops_addr,osm_addr",
  ...tierB.map((p) => {
    const ha = `${p.hops.properties.address["street"] ?? ""} ${p.hops.properties.address["number"] ?? ""}`.trim();
    const oa = `${p.osm.properties.address["street"] ?? ""} ${p.osm.properties.address["number"] ?? ""}`.trim();
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return [
      p.hops.properties.id,
      p.osm.properties.id,
      p.meters.toFixed(1),
      p.sim.toFixed(2),
      esc(p.hops.properties.name),
      esc(p.osm.properties.name),
      esc(ha),
      esc(oa),
    ].join(",");
  }),
].join("\n");

const stats = {
  dry_run: DRY_RUN,
  hops_only_before: hopsOnly.length,
  osm_only_before: osmOnly.length,
  tier_a_merged: tierA.length,
  tier_b_review: tierB.length,
  hops_only_after: hopsOnly.length - tierA.length,
  features_before: doc.features.length + toDelete.size,
  features_after: doc.features.length,
};

if (!DRY_RUN) {
  writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");
  writeFileSync("_dedup-review.csv", csv + "\n", "utf8");
} else {
  writeFileSync("_dedup-review.csv", csv + "\n", "utf8");
  writeFileSync(
    "_dedup-tier-a-sample.csv",
    [
      "osm_id,hops_id,meters,sim,reason,osm_name,hops_name,added,changed",
      ...mergeResults.slice(0, 50).map((r) => {
        const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
        return [
          r.osm_id,
          r.hops_id,
          r.meters,
          r.sim,
          r.reason,
          esc(r.osm_name),
          esc(r.hops_name),
          esc(r.added_keys.join("+")),
          esc(r.changed_keys.join("+")),
        ].join(",");
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}

process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
