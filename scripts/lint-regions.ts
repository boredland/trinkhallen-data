/**
 * Validate regions.yml against schema-level invariants.
 *
 * Exits non-zero on any violation. Wired into .github/workflows/lint.yml
 * so a bad regions.yml fails CI before any scrape can pick it up.
 *
 * Checks:
 *   - slug uniqueness
 *   - path uniqueness
 *   - prefix uniqueness
 *   - prefix matches schema/kiosk.schema.json's id-prefix segment
 *     (^[a-z0-9]+$). Hyphens are NOT allowed even though YAML accepts
 *     them, because the generated id `tk_<prefix>_<rest>` has to round-
 *     trip through ajv with the schema's `^tk_[a-z0-9]+_[a-z0-9_-]+$`
 *     pattern.
 *   - iso3166_2 matches either ISO3166-1 ("DE", "CH") or ISO3166-2
 *     ("DE-NW", "AT-7"). Loose check; we trust Overpass to reject bad
 *     codes at query time.
 *   - role, if present, is either "city" or "rest".
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

interface Region {
  slug: string;
  path: string;
  prefix: string;
  iso3166_2: string;
  role?: string;
}

const PREFIX_RE = /^[a-z0-9]+$/;
const ISO_RE = /^[A-Z]{2}(-[A-Z0-9]+)?$/;

function findDupes<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = buckets.get(k) ?? [];
    arr.push(it);
    buckets.set(k, arr);
  }
  for (const [k, arr] of buckets) if (arr.length < 2) buckets.delete(k);
  return buckets;
}

const txt = await readFile(resolve(REPO_ROOT, "regions.yml"), "utf8");
const doc = YAML.parse(txt) as { regions: Region[] };
const regions = doc.regions ?? [];

const errors: string[] = [];

for (const dupSet of [
  ["slug", findDupes(regions, (r) => r.slug)] as const,
  ["path", findDupes(regions, (r) => r.path)] as const,
  ["prefix", findDupes(regions, (r) => r.prefix)] as const,
]) {
  const [field, dupes] = dupSet;
  for (const [k, rows] of dupes) {
    errors.push(`duplicate ${field} "${k}" in: ${rows.map((r) => r.slug).join(", ")}`);
  }
}

for (const r of regions) {
  if (!PREFIX_RE.test(r.prefix)) {
    errors.push(`${r.slug}: prefix "${r.prefix}" must match ${PREFIX_RE} (no hyphens — generated ids must round-trip through kiosk.schema.json)`);
  }
  if (!ISO_RE.test(r.iso3166_2)) {
    errors.push(`${r.slug}: iso3166_2 "${r.iso3166_2}" doesn't look like ISO 3166-1 or 3166-2`);
  }
  if (r.role !== undefined && r.role !== "city" && r.role !== "rest") {
    errors.push(`${r.slug}: role "${r.role}" must be "city" or "rest"`);
  }
}

if (errors.length > 0) {
  console.error("regions.yml lint failed:");
  for (const e of errors) console.error("  -", e);
  process.exit(1);
}
console.log(`regions.yml: ${regions.length} regions, all checks passed`);
