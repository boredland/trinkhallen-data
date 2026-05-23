/**
 * One-shot: dedupe Hopfenstop ↔ OSM features across every region file.
 *
 * Background. The Hopfenstop seed (one-shot, see _oneoff/import-hopfenstop.ts)
 * covers ~22 German cities, not just Frankfurt. The subsequent OSM scrape
 * pulled in everything Overpass returned for each region without a join
 * step, so each affected region has its own population of hopfenstop-only
 * and osm-only features with significant physical overlap.
 *
 * Strategy (per file). Tier A — auto-merge:
 *   Pair a hopfenstop-only feature with an osm-only neighbour when:
 *     - haversine ≤ 30m AND (dice(name) ≥ 0.55 OR one name is substring of
 *       the other (≥3 chars) OR same street + number), OR
 *     - haversine ≤ 8m (regardless of name) — at that distance it's the
 *       same kiosk that just got renamed (operator change), since
 *       Spätis don't sit 8m apart in practice.
 *   Merge: keep the OSM feature (preserves the upstream node/id reference),
 *   conservatively fill blanks from Hopfenstop (payment "unknown" → known,
 *   missing hours/address/tags/description), union sources[], pick the more
 *   descriptive name, delete the Hopfenstop-only feature.
 *
 * Tier B — manual review:
 *   Pairs with haversine ≤ 30m and dice 0.3–0.55 that didn't make Tier A
 *   land in _dedup-review.csv (combined across files). No data is changed.
 *
 * Run:
 *   bun scripts/_oneoff/dedup-hopfenstop.ts --dry-run    # report only
 *   bun scripts/_oneoff/dedup-hopfenstop.ts              # write changes
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

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

interface Doc {
  type: "FeatureCollection";
  features: Feature[];
}

const DRY_RUN = process.argv.includes("--dry-run");

// Discover region files containing hopfenstop features via a fast jq sweep.
// `|| true` swallows xargs's exit 123 — that fires when any per-file `[ -gt 0 ] && echo`
// short-circuits on a file with no hopfenstop entries, which is expected for most files.
function findFiles(): string[] {
  const out = execSync(
    `find data -name '*.geojson' -print0 | xargs -0 -I{} sh -c 'n=$(jq "[.features[] | select(.properties.sources | any(.type == \\"hopfenstop\\"))] | length" "{}"); [ "$n" -gt 0 ] && echo "{}"' || true`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, shell: "/bin/bash" },
  );
  return out.trim().split("\n").filter(Boolean).sort();
}

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

const today = new Date().toISOString().slice(0, 10);

function mergeFeature(osmF: Feature, hopsF: Feature): void {
  const newName = pickName(osmF.properties.name, hopsF.properties.name);
  if (newName !== osmF.properties.name) osmF.properties.name = newName;

  if (!osmF.properties.description && hopsF.properties.description) {
    osmF.properties.description = hopsF.properties.description;
  }

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
    if (touched) osmF.properties.payment = next;
  }

  if (!osmF.properties.hours?.raw && hopsF.properties.hours?.raw) {
    osmF.properties.hours = { raw: hopsF.properties.hours.raw };
  }

  const a = osmF.properties.address ?? {};
  const b = hopsF.properties.address ?? {};
  for (const [k, v] of Object.entries(b)) {
    if (!a[k] && v) a[k] = v;
  }
  osmF.properties.address = a;

  const tagSet = new Set(osmF.properties.tags ?? []);
  for (const t of hopsF.properties.tags ?? []) tagSet.add(t);
  osmF.properties.tags = [...tagSet].sort();

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
  osmF.properties.updated = today;
}

interface Pair {
  hops: Feature;
  osm: Feature;
  meters: number;
  sim: number;
  reason: string;
}

interface PerFileResult {
  file: string;
  hops_only_before: number;
  osm_only_before: number;
  tier_a_merged: number;
  tier_b_review: number;
  features_before: number;
  features_after: number;
  reviewRows: string[];
}

function processFile(file: string): PerFileResult {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Doc;

  const hopsOnly = doc.features.filter(
    (f) => hasSrc(f, "hopfenstop") && !hasSrc(f, "osm"),
  );
  const osmOnly = doc.features.filter(
    (f) => !hasSrc(f, "hopfenstop") && hasSrc(f, "osm"),
  );

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
      else if (m <= 8) reason = `close-coord=${m.toFixed(1)}m`;
      if (reason) allPairs.push({ hops: h, osm: o, meters: m, sim, reason });
      else if (sim >= 0.3) {
        allPairs.push({ hops: h, osm: o, meters: m, sim, reason: `B:dice=${sim.toFixed(2)}` });
      }
    }
  }

  // Greedy assignment, Tier A first.
  allPairs.sort((a, b) => {
    const aA = !a.reason.startsWith("B:");
    const bA = !b.reason.startsWith("B:");
    if (aA !== bA) return aA ? -1 : 1;
    if (b.sim !== a.sim) return b.sim - a.sim;
    return a.meters - b.meters;
  });

  const tierA: Pair[] = [];
  const tierB: Pair[] = [];
  const claimedOsm = new Set<string>();
  const claimedHops = new Set<string>();
  for (const p of allPairs) {
    if (claimedOsm.has(p.osm.properties.id)) continue;
    if (claimedHops.has(p.hops.properties.id)) continue;
    claimedOsm.add(p.osm.properties.id);
    claimedHops.add(p.hops.properties.id);
    if (p.reason.startsWith("B:")) tierB.push(p);
    else tierA.push(p);
  }

  const featuresBefore = doc.features.length;
  const toDelete = new Set<string>();
  for (const p of tierA) {
    mergeFeature(p.osm, p.hops);
    toDelete.add(p.hops.properties.id);
  }
  doc.features = doc.features.filter((f) => !toDelete.has(f.properties.id));

  if (!DRY_RUN && tierA.length > 0) {
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }

  const region = file.replace(/^data\/de\//, "").replace(/\.geojson$/, "");
  const reviewRows = tierB.map((p) => {
    const ha = `${p.hops.properties.address["street"] ?? ""} ${p.hops.properties.address["number"] ?? ""}`.trim();
    const oa = `${p.osm.properties.address["street"] ?? ""} ${p.osm.properties.address["number"] ?? ""}`.trim();
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return [
      region,
      p.hops.properties.id,
      p.osm.properties.id,
      p.meters.toFixed(1),
      p.sim.toFixed(2),
      esc(p.hops.properties.name),
      esc(p.osm.properties.name),
      esc(ha),
      esc(oa),
    ].join(",");
  });

  return {
    file,
    hops_only_before: hopsOnly.length,
    osm_only_before: osmOnly.length,
    tier_a_merged: tierA.length,
    tier_b_review: tierB.length,
    features_before: featuresBefore,
    features_after: doc.features.length,
    reviewRows,
  };
}

const files = findFiles();
const results = files.map(processFile);

const reviewCsv = [
  "region,hops_id,osm_id,meters,sim,hops_name,osm_name,hops_addr,osm_addr",
  ...results.flatMap((r) => r.reviewRows),
].join("\n");

if (!DRY_RUN) {
  writeFileSync("_dedup-review.csv", reviewCsv + "\n", "utf8");
}

const totals = results.reduce(
  (acc, r) => ({
    files: acc.files + 1,
    files_touched: acc.files_touched + (r.tier_a_merged > 0 ? 1 : 0),
    hops_only_before: acc.hops_only_before + r.hops_only_before,
    osm_only_before: acc.osm_only_before + r.osm_only_before,
    tier_a_merged: acc.tier_a_merged + r.tier_a_merged,
    tier_b_review: acc.tier_b_review + r.tier_b_review,
    features_before: acc.features_before + r.features_before,
    features_after: acc.features_after + r.features_after,
  }),
  {
    files: 0,
    files_touched: 0,
    hops_only_before: 0,
    osm_only_before: 0,
    tier_a_merged: 0,
    tier_b_review: 0,
    features_before: 0,
    features_after: 0,
  },
);

process.stdout.write(
  JSON.stringify(
    {
      dry_run: DRY_RUN,
      totals,
      per_file: results.map((r) => ({
        file: r.file,
        hops_only_before: r.hops_only_before,
        tier_a: r.tier_a_merged,
        tier_b: r.tier_b_review,
        features_delta: r.features_after - r.features_before,
      })),
    },
    null,
    2,
  ) + "\n",
);
