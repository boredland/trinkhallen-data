# Attribution

This dataset is built on the work of others. Please credit them when re-using.

## HopfenStop (Frankfurt seed)

The initial Frankfurt feature set was imported once from the
[HopfenStop](https://github.com/hopfenstop/hopfenstop.github.io) repository
(© the HopfenStop contributors, CC BY-NC 4.0).

Imported features carry a `properties.sources[]` entry of the form:

```json
{ "type": "hopfenstop", "id": "<original kioskId>" }
```

After the one-off import, we do not pull updates from HopfenStop. Ongoing
maintenance is handled in this repository.

## OpenStreetMap (ongoing ingest)

Features with `properties.sources[].type === "osm"` originate from
[OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap
contributors, licensed under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

The weekly Overpass workflow (`.github/workflows/osm-scrape.yml`) opens PRs
adding or updating OSM-derived features.

## Contributors to this repository

Listed via Git history — see <https://github.com/trinkhallen/trinkhallen-data/graphs/contributors>.
