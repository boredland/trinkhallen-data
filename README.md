# trinkhallen-data

Open dataset of **Trinkhallen**, **Wasserhäuschen** and **Spätis** in Germany.

Consumed by [trinkhallen.app](https://trinkhallen.app). The application is just a UI on top of this repository — *the data is the project*.

## Layout

```
data/
  de/<bundesland>/<city>.geojson     One GeoJSON FeatureCollection per city
schema/
  kiosk.schema.json                  JSON Schema for a kiosk Feature
  tags.json                          Controlled vocabulary (slug ⇄ German label)
scripts/
  osm-to-geojson.ts                  Overpass JSON → our GeoJSON normaliser;
                                     home of `ownsFeature` cross-region dedup
  run-osm-scrape.ts                  OSM ingest orchestrator (adds new POIs,
                                     refreshes positions, flags removals)
  enrich-from-osm.ts                 Matches user-submitted features to OSM
                                     nodes; backfills hours / payment / tags
  run-enrich.ts                      Apple-first payment + hours enrichment
                                     pipeline (DDG place_id → maps.apple.com
                                     SSR → amenityV2 + businessHours), then
                                     gosom (Google Maps) for the leftovers.
                                     p-queue per provider, SIGTERM-aware,
                                     stamps `apple_attempted` /
                                     `google_attempted` (30d TTL) so dud
                                     queries don't repeat.
  run-gmaps-confirm.ts               Optional gosom confirmation pass for
                                     uncertain enrich-from-osm matches
  _oneoff/                           Archived one-shots (Frankfurt seed,
                                     bundesland anchor split)
regions.yml                          Region definitions for the OSM workflow
.github/workflows/
  osm.yml                            Unified OSM ingest + enrichment. Two
                                     modes via cron schedule or
                                     `workflow_dispatch`:
                                       - scrape  (weekly): adds new kiosks,
                                                 flags removed
                                       - enrich  (monthly): fills blanks
                                                 from matched OSM POIs
  enrich.yml                         Hourly Apple+Google enrichment for one
                                     random region (or a chosen one via
                                     dispatch). gosom runs as a persistent
                                     sidecar; the script self-bounds via
                                     `--max-runtime-min`. Per-region
                                     `concurrency` keys keep two runs from
                                     racing the same geojson.
  deploy-app.yml                     On push to main, POSTs the Cloudflare
                                     Deploy Hook on trinkhallen.app
```

## Schema

See `schema/kiosk.schema.json`. Quick reference:

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [<lng>, <lat>] },
  "properties": {
    "id": "tk_fr_001",
    "name": "Kayo am Rebstock",
    "description": "…",
    "address": { "street": "…", "number": "…", "postalcode": "…", "city": "…", "district": "…" },
    "hours": { "raw": "Mo-Su 09:00-01:00" },
    "tags": ["snacks", "wc"],
    "payment": { "cash": "yes", "cards": "yes", "contactless": "unknown", "girocard": "unknown", "mobile": "unknown" },
    "sources": [
      { "type": "osm",   "id": "node/1234567890", "version": 7 },
      { "type": "apple", "id": "IBD3E3D943B1EC865" },
      { "type": "gmaps", "id": "ChIJKdVHkYbOl0cRSCjlg8Gt0hg" }
    ],
    "created": "2026-05-20",
    "updated": "2026-05-23",
    "apple_id_attempted": "2026-05-23",
    "apple_attempted":    "2026-05-23",
    "google_attempted":   "2026-05-23"
  }
}
```

`sources[].id` carries the upstream's canonical identifier so re-enrichment can
hit the place directly instead of re-searching by name + coords. The
`*_attempted` stamps mark "we tried this provider on this date and got
nothing useful" so subsequent runs skip the call until the 30-day TTL lapses.

## Pushing changes

**Hand-authored edits go directly to `main`** — no PR. Rebase before pushing:

```sh
git checkout main && git pull --rebase
# edit…
git add data/…
git commit -m "…"
git push        # on rejection: git pull --rebase && git push
```

The workflows above use the same pattern: 5-attempt push/rebase loop with
`-X theirs` to auto-resolve text conflicts in `data/**` when two runs land on
the same file. No `peter-evans/create-pull-request` anywhere.

Edits submitted through trinkhallen.app's report/submit flow *do* land via PR
(the app has no commit credentials here) — those go through the bot account.

## Contributing

- **Add or fix a kiosk**: easiest is the in-app report/submit flow on
  trinkhallen.app. For bulk fixes, edit the relevant city's `.geojson`
  directly on `main` (see "Pushing changes" above).
- **Add a new city/region**: add an entry to `regions.yml`, then trigger
  `osm` (manual `workflow_dispatch` with `mode=scrape`, or wait for the
  weekly cron). The OSM scraper's `ownsFeature` rule auto-dedupes against
  overlapping neighbours, so a generous bbox is safe — anything closer to
  another region's anchor will be claimed by that region.
- **Tag vocabulary**: changes go through `schema/tags.json`. Don't invent
  ad-hoc tags — propose them in a PR.
- **Schema**: `schema/kiosk.schema.json` has `additionalProperties: false`.
  New feature properties require a schema update first or the next scrape
  PR will fail validation.

## How it deploys downstream

Pushes here that touch `data/**`, `regions.yml`, or `schema/**` trigger
`.github/workflows/deploy-app.yml`, which POSTs to a Cloudflare Deploy
Hook URL (stored as the `CF_DEPLOY_HOOK_URL` repo secret). That triggers
trinkhallen.app's Cloudflare Workers Builds run, which shallow-clones
this repo during its build step and bakes the fresh GeoJSON into the
Worker's Assets bundle.

There is no `/api/sync` webhook on the app side — runtime data freshness
comes from redeploys, not D1 mutations.

## License

- Data: [CC BY-NC 4.0](./LICENSE.md). See attribution notes for OSM and HopfenStop provenance.
- Code: AGPL-3.0-or-later.

See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for credits.
