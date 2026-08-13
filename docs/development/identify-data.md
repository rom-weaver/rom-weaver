# ROM identify data

The `identify` and `ingest` commands use compact RWFP1 title packs. The native CLI embeds the shipped packs.

The browser downloads applicable packs when it ingests a ROM or patch. It then caches the packs for later offline use.

Ingest resolves ROM assets from their computed checksum variants. It also resolves a patch's expected source from embedded or file-name checksums. It does not hash the ROM or patch twice.

<!-- START doctoc -->
## Table of contents

- [Shipped data](#shipped-data)
- [Local Hasheous data](#local-hasheous-data)
- [Pack integrity](#pack-integrity)

<!-- END doctoc -->

## Shipped data

The repository ships data from [OpenGood](https://github.com/SnowflakePowered/opengood). OpenGood publishes its data under CC0-1.0.

The build script pins the OpenGood revision. This makes the generated packs deterministic.

Rebuild all shipped packs:

```bash
script=scripts/build-hasheous-identify-index.mjs
out=crates/rom-weaver-cli/data/identify/v1
node "$script" --opengood-only --no-brotli --out "$out"
```

Run the command a second time. Confirm that `git diff` shows no pack changes.

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
