/**
 * Secondary payment-info enrichment via gosom/google-maps-scraper.
 *
 * For every feature in data/**.geojson that has no `payment` block,
 * query gosom by name + coords (50 m radius confirmation, same as
 * run-gmaps-confirm.ts), parse the "About → Zahlungen" entries from
 * gosom's Entry struct, map the German labels to our tri-state schema,
 * and write back. Conservative — only sets fields that were missing;
 * never overwrites existing payment values.
 *
 * Throttling
 *   - One docker invocation at a time. Gosom uses ~500 MB RAM per run
 *     and Playwright doesn't parallelise cleanly.
 *   - 2 s sleep between queries (polite to Google's edge).
 *   - Caps at GMAPS_PAYMENT_BATCH (default 100) features per invocation.
 *   - Daily cron in .github/workflows/gmaps-payment.yml. Manual dispatch
 *     accepts `batch` and `region` inputs.
 *
 * Selection
 *   - Filter to features missing the payment block entirely (no useful
 *     overlap with OSM-tagged payment data; we'd rather extend than
 *     argue with OSM).
 *   - Skip features whose `name` is shorter than MIN_NAME_LENGTH (gosom
 *     can't usefully disambiguate "Kiosk" or "Späti").
 *   - Skip features whose `payment_attempted` was within the last
 *     ATTEMPTED_TTL_DAYS — we already queried gosom and either got no
 *     match or no payment block; re-querying every day is wasted budget.
 *   - Random sample of N each run (seeded by date so the same run on
 *     the same day produces the same set, which makes failures easier
 *     to retry).
 *
 * Durability
 *   - Each modified file is flushed to disk after every iteration that
 *     touched it (typically one file per region job). On SIGTERM (GH
 *     sends it ~5min before the job timeout SIGKILL) the loop exits
 *     cleanly so the workflow's diff + PR steps still run on partial
 *     progress instead of losing hours of work.
 *   - --max-runtime-min bounds wall-clock independently of the job
 *     timeout, leaving headroom for the PR step on big regions.
 *
 * ToS posture
 *   See run-gmaps-confirm.ts header. This script adds another low-volume
 *   monthly throughput (100 × 30 ≈ 3000 queries/month). Detection risk
 *   is meaningfully larger than the existing ~tens/month, deliberately
 *   accepted by the operator.
 *
 * Usage
 *   bun scripts/run-gmaps-payment.ts [--batch N] [--region <slug>]
 *                                    [--max-runtime-min N] [--dry-run]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const TMP_DIR = join(REPO_ROOT, ".tmp/gmaps-payment");
const SCRAPER_IMAGE = "gosom/google-maps-scraper";
const CONFIRM_RADIUS_M = 50;
const SEARCH_RADIUS_M = 300;
const GOSOM_TIMEOUT_S = 60;
const SLEEP_MS = 2000;
const MIN_NAME_LENGTH = 3;
const DEFAULT_BATCH = 100;
const DEFAULT_MAX_RUNTIME_MIN = 320;
const ATTEMPTED_TTL_DAYS = 30;

// ── types ──────────────────────────────────────────────────────────────────

type TriState = "yes" | "no" | "unknown";

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name?: string;
    payment?: Partial<Record<"cash" | "cards" | "contactless" | "girocard" | "mobile", TriState>>;
    payment_attempted?: string; // ISO date — we queried gosom but didn't write
    sources?: Array<{ type: string; id: string; version?: number }>;
    updated?: string;
    kind?: string;
    [k: string]: unknown;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

// Subset of gosom's Entry struct — see gosom/gmaps/entry.go.
interface GmapsOption {
  name: string;
  enabled: boolean;
}
interface GmapsAbout {
  id?: string;
  name: string;
  options: GmapsOption[];
}
interface GmapsResult {
  title?: string;
  latitude?: number;
  longitude?: number;
  longtitude?: number; // gosom typo
  about?: GmapsAbout[];
}

interface Stats {
  considered: number;
  skipped_recent_attempt: number;
  queried: number;
  matched: number;
  written: number;
  no_match: number;
  errored: number;
  stopped_reason?: "sigterm" | "max_runtime" | "batch_done";
}

// ── helpers ────────────────────────────────────────────────────────────────

function args(): {
  batch: number;
  region: string | null;
  maxRuntimeMin: number;
  dryRun: boolean;
} {
  const a = process.argv.slice(2);
  const batchIx = a.indexOf("--batch");
  const regionIx = a.indexOf("--region");
  const maxRuntimeIx = a.indexOf("--max-runtime-min");
  const batch = batchIx >= 0 ? parseInt(a[batchIx + 1] ?? "", 10) : NaN;
  const envBatch = parseInt(process.env["GMAPS_PAYMENT_BATCH"] ?? "", 10);
  const maxRuntime =
    maxRuntimeIx >= 0
      ? parseInt(a[maxRuntimeIx + 1] ?? "", 10)
      : parseInt(process.env["GMAPS_PAYMENT_MAX_RUNTIME_MIN"] ?? "", 10);
  return {
    batch: Number.isFinite(batch) ? batch : Number.isFinite(envBatch) ? envBatch : DEFAULT_BATCH,
    region: regionIx >= 0 ? (a[regionIx + 1] ?? null) : null,
    maxRuntimeMin: Number.isFinite(maxRuntime) ? maxRuntime : DEFAULT_MAX_RUNTIME_MIN,
    dryRun: a.includes("--dry-run"),
  };
}

function daysSince(iso: string | undefined, today: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (today.getTime() - t) / 86_400_000;
}

function resultLng(r: GmapsResult): number | undefined {
  return typeof r.longitude === "number" ? r.longitude : r.longtitude;
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function isDockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
  return r.status === 0;
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

// Seeded RNG (mulberry32) — same daily seed picks the same batch on retries.
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], seed: number): T[] {
  const r = rng(seed);
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ── gosom invocation ───────────────────────────────────────────────────────

async function queryGmaps(name: string, lat: number, lng: number): Promise<GmapsResult[]> {
  mkdirSync(TMP_DIR, { recursive: true });
  const inputPath = join(TMP_DIR, "in.txt");
  const outputPath = join(TMP_DIR, "out.json");
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
    "/work/in.txt",
    "-results",
    "/work/out.json",
    "-json",
    "-geo",
    `${lat},${lng}`,
    "-radius",
    String(SEARCH_RADIUS_M),
    "-zoom",
    "18",
    "-depth",
    "1",
    "-c",
    "1",
    "-exit-on-inactivity",
    `${GOSOM_TIMEOUT_S}s`,
  ];
  execFileSync("docker", dockerArgs, { stdio: ["ignore", "ignore", "pipe"] });

  const buf = await readFile(outputPath, "utf8").catch(() => "");
  if (!buf.trim()) return [];
  try {
    const arr = JSON.parse(buf);
    if (Array.isArray(arr)) return arr as GmapsResult[];
    return [arr as GmapsResult];
  } catch {
    const out: GmapsResult[] = [];
    for (const line of buf.split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as GmapsResult);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

// ── payment mapping ────────────────────────────────────────────────────────

/**
 * Map gosom's "About → Zahlungen" Options[] to our tri-state payment schema.
 * Gosom returns the labels in the locale Google serves (de-DE here). We match
 * by substring on the normalised lowercased name, so localisation drift on
 * either side doesn't break us silently.
 */
function parsePaymentFromAbout(
  about: GmapsAbout[] | undefined,
): Partial<Record<"cash" | "cards" | "contactless" | "girocard" | "mobile", TriState>> | null {
  if (!about) return null;
  const section = about.find((a) => /zahlung|payment/i.test(a.name ?? ""));
  if (!section) return null;
  const out: Partial<
    Record<"cash" | "cards" | "contactless" | "girocard" | "mobile", TriState>
  > = {};

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

  return Object.keys(out).length > 0 ? out : null;
}

// ── main loop ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { batch, region, maxRuntimeMin, dryRun } = args();
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today);
  const seed = Number(today.split("-").join("")); // 20260521 → numeric seed
  const startedAt = Date.now();
  const maxRuntimeMs = maxRuntimeMin * 60_000;

  if (!isDockerAvailable() && !dryRun) {
    process.stdout.write(
      JSON.stringify({ skipped: "docker unavailable", batch, region }, null, 2) + "\n",
    );
    return;
  }

  const files = await findGeojsonFiles();
  const candidates: Array<{ file: string; index: number; feature: Feature }> = [];
  let skippedRecentAttempt = 0;

  for (const file of files) {
    if (region && !file.endsWith(`/${region}.geojson`)) continue;
    const doc = JSON.parse(await readFile(file, "utf8")) as FeatureCollection;
    for (let i = 0; i < doc.features.length; i++) {
      const f = doc.features[i]!;
      if (f.properties.payment) continue;
      if (f.properties.kind === "vending_machine") continue;
      if (!f.properties.name || f.properties.name.length < MIN_NAME_LENGTH) continue;
      if (daysSince(f.properties.payment_attempted, todayDate) < ATTEMPTED_TTL_DAYS) {
        skippedRecentAttempt++;
        continue;
      }
      candidates.push({ file, index: i, feature: f });
    }
  }

  const considered = candidates.length;
  const shuffled = shuffle(candidates, seed);
  const todo = shuffled.slice(0, batch);

  const stats: Stats = {
    considered,
    skipped_recent_attempt: skippedRecentAttempt,
    queried: 0,
    matched: 0,
    written: 0,
    no_match: 0,
    errored: 0,
  };

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        { ...stats, would_query: todo.length, sample: todo.slice(0, 5).map((c) => c.feature.properties.id) },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.error(`Pulling ${SCRAPER_IMAGE}…`);
  spawnSync("docker", ["pull", SCRAPER_IMAGE], { stdio: ["ignore", "ignore", "inherit"] });

  // GH sends SIGTERM ~5 min before the job timeout SIGKILL. Flip the flag so
  // the loop exits at the next iteration boundary, the dirty files get
  // flushed, and the workflow's diff + create-pull-request steps still run.
  let stopRequested: Stats["stopped_reason"] | null = null;
  const requestStop = (reason: NonNullable<Stats["stopped_reason"]>): void => {
    if (!stopRequested) {
      stopRequested = reason;
      console.error(`stop requested: ${reason}`);
    }
  };
  process.on("SIGTERM", () => requestStop("sigterm"));
  process.on("SIGINT", () => requestStop("sigterm"));

  // Group writes by file; flush dirty files after every iteration so a
  // timeout / SIGTERM leaves the disk in a consistent state with whatever
  // progress was made.
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

  // Stamp payment_attempted on a feature we queried but didn't write payment
  // for — so daily re-runs skip it for ATTEMPTED_TTL_DAYS instead of grinding
  // through the same long tail of duds every time.
  async function stampAttempted(file: string, index: number): Promise<void> {
    const doc = await ensureDoc(file);
    const f = doc.features[index];
    if (!f) return;
    f.properties.payment_attempted = today;
    dirty.add(file);
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

    stats.queried++;
    let results: GmapsResult[];
    try {
      results = await queryGmaps(name, lat, lng);
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`);
      stats.errored++;
      await stampAttempted(c.file, c.index);
      await flushDirty();
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      continue;
    }

    const match = results.find((r) => {
      const rLng = resultLng(r);
      if (typeof r.latitude !== "number" || typeof rLng !== "number") return false;
      return haversineMeters(lat, lng, r.latitude, rLng) <= CONFIRM_RADIUS_M;
    });
    if (!match) {
      stats.no_match++;
      await stampAttempted(c.file, c.index);
      await flushDirty();
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      continue;
    }
    stats.matched++;

    const payment = parsePaymentFromAbout(match.about);
    if (!payment) {
      console.error("  matched but no payment options surfaced");
      await stampAttempted(c.file, c.index);
      await flushDirty();
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      continue;
    }

    const doc = await ensureDoc(c.file);
    const feature = doc.features[c.index];
    if (feature && !feature.properties.payment) {
      feature.properties.payment = payment;
      feature.properties.updated = today;
      // Clear any stale attempted stamp now that we have a real answer.
      delete feature.properties.payment_attempted;
      const sources = feature.properties.sources ?? [];
      if (!sources.some((s) => s.type === "gmaps")) {
        sources.push({ type: "gmaps", id: "payment" });
        feature.properties.sources = sources;
      }
      stats.written++;
      dirty.add(c.file);
      console.error(
        `  +payment: ${Object.entries(payment)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      );
    }

    await flushDirty();
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  await flushDirty();
  stats.stopped_reason = stopRequested ?? "batch_done";
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
