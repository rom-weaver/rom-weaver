# ROM identify data

The `identify` and `ingest` commands use compact RWFP1 title packs. The native CLI embeds the shipped packs.

The browser receives all shipped packs in the app's offline cache. The packs are self-hosted Brotli assets.

Ingest resolves ROM assets from their computed checksum variants. It also resolves a patch's expected source from embedded or file-name checksums. It does not hash the ROM or patch twice.

<!-- START doctoc -->
## Table of contents

- [Build-time data](#build-time-data)
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

The CLI crate includes the generated files in its Cargo package archive. Run `mise run identify-data` before `cargo package` or `cargo publish`.

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

`index.json` records the byte length and SHA-256 checksum for each pack. The browser verifies both values before it stages a pack.

The pack reader also validates all offsets, table sizes, and member types. Invalid packs fail before a lookup starts.
