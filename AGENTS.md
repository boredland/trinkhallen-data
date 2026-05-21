# AGENTS.md

Orientation for LLM coding sessions. The data is the project — the app
on top is replaceable, the dataset isn't.

## What lives here

- `data/de/<bundesland>/<city>.geojson` — one FeatureCollection per region.
  Authoritative.
- `regions.yml` — region registry consumed by every workflow.
- `schema/kiosk.schema.json` — feature shape. `additionalProperties: false`,
  so new fields require a schema bump first.
- `schema/tags.json` — controlled vocabulary for the `tags[]` array
  (slug → German label).
- `scripts/` — OSM scrape, enrichment, gosom confirmation, one-off seeds.
- `.github/workflows/` — three cron-driven workflows (see table below).

## Workflows

| Workflow | Cadence | What it does |
|---|---|---|
| `osm-scrape.yml` | Weekly (Mon 04:17 UTC) + dispatch | Overpass-fetches kiosks per region's bbox, merges into the region file. Drops OSM-only features no longer in Overpass; appends genuinely new ones; cross-region dedup via `ownsFeature`. Opens a PR. |
| `osm-enrich.yml` | Monthly + dispatch | Walks features without an OSM source, matches them to Overpass POIs by name+distance, backfills `hours`/`payment`/`address`/`tags`. Defaults to a `--since 40d` cutoff so each run only retries recently-added or recently-edited features; dispatch with `full=true` for a sweep. Opens a PR. |
| `deploy-app.yml` | Push to main (paths: data, regions.yml, schema) | POSTs `$CF_DEPLOY_HOOK_URL` to redeploy trinkhallen.app. |

The OSM scrape's matching/dedup logic lives in
`scripts/osm-to-geojson.ts` (`ownsFeature`, the bbox-center distance
rule) and `scripts/run-osm-scrape.ts` (the merge pass). Both are pure
TypeScript run via Bun in CI.

## Schema

Authoritative shape is `schema/kiosk.schema.json`. New properties:

1. Add to the schema with strict types + `additionalProperties: false`.
2. Mirror in the relevant script's `Feature` interface.
3. Mirror downstream in trinkhallen-app's `src/lib/asset-kiosks.ts`
   `Feature.properties` interface so the app sees it.

Don't store synthesised values that the app could compute (e.g. distance,
"is open now"). Those belong in the app.

## Cross-region dedup

`ownsFeature(region, allRegions, lng, lat)` in
`scripts/osm-to-geojson.ts` returns true if `region`'s bbox is the
closest-anchor bbox containing the point, false otherwise. The OSM
scrape applies it twice in `run-osm-scrape.ts`:

1. To **fresh** Overpass results — features owned by another region are
   dropped before they enter the merge set, so we never write the same
   OSM node into two region files.
2. To **existing** OSM-only features whose ids aren't in fresh — if
   another region owns them now, they're deleted instead of being
   flagged `osm_removed: true`. This cleaned up the 781 cross-region
   dupes that existed prior to PR #11.

Practical consequence: when adding a region in `regions.yml`, you don't
have to draw a tight bbox to avoid stepping on neighbours. A generous
bbox is safe — anything that geographically belongs to a different
region won't be claimed.

## File sorting

`run-osm-scrape.ts` writes features sorted by id (non-OSM block first,
then OSM block, both sorted) so a scrape PR's diff is content-only and
never re-orders existing entries. Any new script that writes to
`data/**` should follow the same rule or the diffs become unreviewable.

## Don'ts

- **Don't bypass the schema.** `additionalProperties: false` is there
  on purpose; new fields need an explicit declaration.
- **Don't write to `data/**` from a script without sorting.** Per
  PR #14: both OSM and non-OSM blocks sort by `properties.id`.
- **Don't scrape Google Maps for ratings at scale.** Considered and
  deferred — see decision log below.
- **Don't add a region without `iso3166_2` + `admin_level: 6`** (or
  `admin_level: 4` for the three city-states: Berlin, Hamburg, Bremen).
  The fields are unused by Overpass today but are kept so a future
  area-based filter has them ready.

## Decision log

- **2026-05-20 — Cross-region dedup added (PR #11).** Overlapping bboxes
  used to double-write OSM nodes into two region files. `ownsFeature`
  now picks one region per point by closest bbox center.
- **2026-05-20 — App webhook removed.** The runtime `/api/sync` path
  from this repo into the app's D1 is gone; the app now bakes our
  GeoJSON into a static bundle on each deploy. `deploy-app.yml`
  triggers that deploy.
- **2026-05-21 — Sort non-OSM block (PR #14).** Both blocks now sort by
  id so scrape PRs never show reorder churn.
- **2026-05-21 — Enrichment `--since` filter (PR #15).** Monthly cron
  defaults to a 40-day cutoff; a `--full` flag covers periodic sweeps.
- **2026-05-21 — Coverage to all >100k cities (PR #16).** Added 17
  regions to cover Kassel, Göttingen, Koblenz, Lübeck, Regensburg, …
  Every German city >100k now sits inside some region bbox.
- **2026-05-21 — Google Maps ratings: deferred indefinitely.** Considered
  scraping aggregate ratings (avg, review count) for ~12k features via
  gosom/google-maps-scraper. Would have been stored as
  `google_rating: { avg, count, fetched_at }` on each feature (a
  synthetic user row in the D1 ratings table is a non-starter — integer-
  stars CHECK constraint + aggregate-vs-individual mismatch). Scrapped
  because the cadence for useful coverage (≥1000 queries/hour) escalates
  from the existing accepted "tens per month" ToS posture to a
  meaningfully harder one without enough user-visible payoff yet.
  Revisit when (a) community ratings remain too sparse to be useful AND
  (b) we're willing to pay for the official Google Places API (~€17/1000
  requests, ToS-clean).

When adding a new entry: date it, name what changed, link the PR.
