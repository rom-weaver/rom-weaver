# ROM identify data

The `identify` and `ingest` commands use compact RWFP1 title packs. The native CLI embeds the shipped packs.

The browser downloads only the packs a given input could match, and caches each one after its first use. The packs are self-hosted Brotli assets.

Ingest resolves ROM assets from their computed checksum variants. It also resolves a patch's expected source from embedded or file-name checksums. It does not hash the ROM or patch twice.

<!-- START doctoc -->
## Table of contents

- [Build-time data](#build-time-data)
- [Browser pack selection](#browser-pack-selection)
- [Browser caching](#browser-caching)
- [Local Hasheous data](#local-hasheous-data)
- [Pack integrity](#pack-integrity)

<!-- END doctoc -->

## Build-time data

The repository does not commit identify packs. Build tasks fetch data from [OpenGood](https://github.com/SnowflakePowered/opengood) and create the packs locally.

OpenGood publishes its data under CC0-1.0. The source revision is pinned in `scripts/build-hasheous-identify-index.mjs`.

The current source is the upstream repository because `rom-weaver/open-good` does not exist. The source URL and revision are kept together so a maintained fork can replace it later.

Run the build step directly:

```bash
mise run identify-data
```

The standard Rust and WASM tasks, webapp build, and CLI crate build script run this step automatically. The generated files live under `crates/rom-weaver-cli/data/identify/v1`, which Git ignores.

Rebuild the packs after changing the source revision:

```bash
node scripts/ensure-identify-data.mjs --force
```

The generated index records the source revision. The browser build compresses the raw packs into its self-hosted Brotli sidecars.

The CLI crate includes the generated files in its Cargo package archive. Run `mise run identify-data` before `cargo package --allow-dirty` or `cargo publish --allow-dirty`.

## Browser pack selection

The browser picks packs in two stages, so a drop never downloads the whole set when one system will do.

1. The file name decides first. A `.gba` drop selects the Game Boy Advance pack and nothing else.
2. A name that decides nothing (`.zip`, `.7z`, `.bin`, `.rom`) triggers a decompression-free `probe`. The probe returns the archive's member list and the ROM header's platform, and those select the packs.

A detected platform widens to its siblings, because a header cannot separate Game Boy from Game Boy Color, Master System from Game Gear, or Neo Geo Pocket from its Color model. A wrong sibling costs one extra pack; a missing sibling would report a wrong "no match".

The full set loads only when neither stage narrows the input. Correctness wins over transfer size: skipping a pack a ROM could match would report a wrong result.

## Browser caching

The full pack set is 6.7 MB raw and about 1.6 MB after Brotli. Precaching all of it would put that on every service-worker install and every update, for a feature a session usually needs one system for.

The service worker therefore precaches only `assets/identify-index.json` and runtime-caches each pack on first use, in a dedicated `identify` cache. Offline identification works for every system whose pack has been fetched once.

Each pack URL carries its own `sha256` query, so a rebuilt pack is a new cache key. The runtime handler deletes the superseded entry for the same file after it stores the new one.

## Local Hasheous data

[Hasheous](https://github.com/gaseous-project/hasheous) provides more systems. Its aggregated data does not state redistribution rights.

Do not commit Hasheous-derived packs. Keep these packs local.

Build one local pack from an existing metadata dump:

```bash
script=scripts/build-hasheous-identify-index.mjs
dump=/path/to/MetadataMap.zip
node "$script" --dump "$dump" --only "Sony PlayStation" --out target/identify
```

Pass the generated pack to the CLI:

```bash
database=target/identify/sony-playstation.pack
rom-weaver identify --input game.bin --database "$database"
```

## Pack integrity

`index.json` records the byte length and SHA-256 checksum for each pack. The browser verifies both values before it stages a pack. A pack that fails either check, or an index that cannot be fetched or parsed, makes identification **unavailable** - a state the UI reports separately from a genuine "no title matched".

The pack reader also validates all offsets, table sizes, and member types. Invalid packs fail before a lookup starts.
