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
  _oneoff/import-hopfenstop.ts       One-shot Frankfurt seed importer (archived)
  osm-to-geojson.ts                  Overpass JSON → our GeoJSON normaliser;
                                     home of `ownsFeature` cross-region dedup
  run-osm-scrape.ts                  Weekly OSM ingest orchestrator (adds new POIs)
  enrich-from-osm.ts                 Monthly enrichment — fills blanks on
                                     existing features from matched OSM POIs
  run-gmaps-confirm.ts               Optional gosom/google-maps-scraper pass
                                     to confirm uncertain enrichment matches
regions.yml                          Region definitions for the OSM workflow
.github/workflows/
  osm-scrape.yml                     Weekly OSM ingest → opens PRs
  osm-enrich.yml                     Monthly enrichment → opens PRs; takes a
                                     `--since` cutoff so re-runs only touch
                                     features added/edited in the window
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
    "sources": [ { "type": "osm", "id": "node/1234567890", "version": 7 } ],
    "created": "2026-05-20",
    "updated": "2026-05-20"
  }
}
```

## Contributing

- **Add or fix a kiosk**: edit the relevant city's `.geojson`, open a PR.
  Most user-facing edits land via trinkhallen.app's submit/report flow,
  which opens the PR for you.
- **Add a new city/region**: add an entry to `regions.yml`, then trigger
  `osm-scrape` (manual `workflow_dispatch` for that slug, or wait for the
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

There is no longer a `/api/sync` webhook on the app side — runtime data
freshness comes from redeploys, not D1 mutations.

## License

- Data: [CC BY-NC 4.0](./LICENSE.md). See attribution notes for OSM and HopfenStop provenance.
- Code: AGPL-3.0-or-later.

See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for credits.
