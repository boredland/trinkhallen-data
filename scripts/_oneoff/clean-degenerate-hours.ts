/**
 * One-shot: walk every region file and drop hours strings that
 * cleanOpeningHours() rejects (zero-length 00:00-00:00 ranges, empties).
 *
 * Future ingest paths (osm-to-geojson, enrich-from-osm) call the same
 * helper, so this is purely a backfill for data that pre-dates the
 * filter.
 *
 * Run:
 *   bun scripts/_oneoff/clean-degenerate-hours.ts --dry-run
 *   bun scripts/_oneoff/clean-degenerate-hours.ts
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanOpeningHours } from "../lib/opening-hours.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const DRY_RUN = process.argv.includes("--dry-run");

interface Feature {
  properties: {
    id: string;
    name?: string;
    hours?: { raw?: string };
    sources_by_field?: Record<string, string>;
    [k: string]: unknown;
  };
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

interface PerFileStats {
  file: string;
  cleaned: number;
  examples: string[];
}

async function main(): Promise<void> {
  const files = await walkGeojsonFiles();
  const allStats: PerFileStats[] = [];

  for (const file of files) {
    const doc = JSON.parse(await readFile(file, "utf8")) as { features: Feature[] };
    const stats: PerFileStats = {
      file: file.replace(`${REPO_ROOT}/`, ""),
      cleaned: 0,
      examples: [],
    };
    let dirty = false;
    for (const f of doc.features) {
      const raw = f.properties.hours?.raw;
      if (!raw) continue;
      if (cleanOpeningHours(raw) !== null) continue;
      delete f.properties.hours;
      if (f.properties.sources_by_field) {
        delete f.properties.sources_by_field["hours"];
        if (Object.keys(f.properties.sources_by_field).length === 0) {
          delete f.properties.sources_by_field;
        }
      }
      stats.cleaned++;
      if (stats.examples.length < 3) {
        stats.examples.push(`${f.properties.id}: ${JSON.stringify(raw)}`);
      }
      dirty = true;
    }
    if (dirty && !DRY_RUN) {
      await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
    }
    if (stats.cleaned > 0) allStats.push(stats);
  }

  const totalCleaned = allStats.reduce((acc, s) => acc + s.cleaned, 0);
  process.stdout.write(
    JSON.stringify(
      { dry_run: DRY_RUN, files_touched: allStats.length, total_cleaned: totalCleaned, per_file: allStats },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
