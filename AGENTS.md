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
| `osm.yml` (mode `scrape`) | Weekly (Mon 04:17 UTC) + dispatch | Overpass-fetches kiosks per region, merges into the region file. Drops OSM-only features no longer in Overpass; appends genuinely new ones; cross-region dedup via `ownsFeature`. Full runs split into 4 parallel `--shard i/4` jobs, each with `--max-runtime-min 70`, failing over between `OVERPASS_ENDPOINT` hosts. Each shard commits to main; one `deploy` job rebuilds the app. |
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
- **2026-10-14 — Spain added (19 rests, `data/es/<comunidad>/`).** One
  ISO 3166-2 rest per comunidad autónoma plus Ceuta/Melilla, no city
  regions yet. Spanish `shop=kiosk` is mostly press stands, ONCE lottery
  booths and estancos, so `isSpanishNonDrinkKiosk` in
  `scripts/osm-to-geojson.ts` drops those by `lottery=*`, an `ONCE`
  name/brand/operator, or a name containing prensa/revistas/estanco/tabacos
  (about a third of named Madrid entries). Bare "Kiosco"/"Quiosco" is kept:
  that is also the name of park drinks kiosks. The app has no Spanish UI or
  Spanish holiday calendar; `PH` rules there resolve against its default
  Baden-Württemberg calendar.
- **2026-10-14 — Scrape made to finish inside the job timeout.** Since
  August 6 of 9 weekly scrapes hit the 90 min cancel: overpass-api.de
  alternated 504s with accepted-then-stalled connections, and an un-timed
  `fetch` plus 5 retries cost ~12 min per region, so rest regions (AT/CH/
  …/ES, last in order) were never reached. Now each attempt is capped at
  150 s (`[timeout:120]` server-side), retries rotate through
  `OVERPASS_ENDPOINT` (comma list; default overpass-api.de,
  private.coffee, maps.mail.ru) and the next region starts on the last
  host that answered, 4 consecutive all-endpoint failures stop the run,
  and `osm.yml` passes `--max-runtime-min 70` so unfinished regions are
  listed as "Not attempted" and the commit step always runs. The first
  run with that still covered only 42 of 93 regions in 70 min (8 failed
  regions took 3.5-7 min each), so a full scrape now runs as 4 parallel
  `--shard i/4` matrix jobs; regions write disjoint files, so shard
  commits only race on push, which the rebase loop handles.
  The sharded run then showed overpass.private.coffee answering area
  queries with HTTP 200 and zero elements (IT-BZ: 0 vs 105 on
  overpass-api.de), which flagged 18 Südtirol and 55 Steiermark kiosks
  `osm_removed`. Those flags were reverted, and `processRegion` now passes
  `minElements` (half the region's live OSM-sourced features, once there
  are ≥10) so a suspiciously small answer is retried on the next endpoint
  instead of being merged.

When adding a new entry: date it, name what changed, link the PR.
