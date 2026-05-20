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
  osm-to-geojson.ts                  Overpass JSON → our GeoJSON normaliser
  run-osm-scrape.ts                  Weekly OSM ingest orchestrator (adds new POIs)
  enrich-from-osm.ts                 Monthly enrichment — fills blanks on
                                     existing features from matched OSM POIs
regions.yml                          Region definitions for the OSM workflow
.github/workflows/
  osm-scrape.yml                     Weekly OSM ingest → opens PRs
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
- **Add a new city/region**: add an entry to `regions.yml`, run the OSM workflow manually, review the resulting PR.
- **Tag vocabulary**: changes go through `schema/tags.json`. Don't invent ad-hoc tags — propose them in a PR.

## License

- Data: [CC BY-NC 4.0](./LICENSE.md). See attribution notes for OSM and HopfenStop provenance.
- Code: AGPL-3.0-or-later.

See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for credits.
