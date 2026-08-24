# ROM identify data

The `identify` and `ingest` commands use compact title packs: RWFP1 for the shipped OpenGood data, RWFP2 for set-aware Hasheous data. The native CLI embeds the shipped packs.

The browser downloads only the packs a given input could match, and caches each one after its first use. The packs are self-hosted Brotli assets.

Ingest resolves ROM assets from their computed checksum variants. It also resolves a patch's expected source from embedded or file-name checksums. It does not hash the ROM or patch twice.

<!-- START doctoc -->
## Table of contents

- [Build-time data](#build-time-data)
- [Browser pack selection](#browser-pack-selection)
- [Browser caching](#browser-caching)
- [Source policy](#source-policy)
- [Catalog](#catalog)
- [RWFP2 packs](#rwfp2-packs)
- [Shared tracks](#shared-tracks)
- [Determinism](#determinism)
- [Provenance](#provenance)
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

## Source policy

`scripts/build-hasheous-identify-index.mjs` builds from exactly two sources, one per platform:

- `OPENGOOD_PLATFORMS` names the 17 cartridge platforms OpenGood covers exclusively. These build RWFP1 packs and ship with the tool.
- Every other platform comes from a [Hasheous](https://github.com/gaseous-project/hasheous) `MetadataMap.zip` dump and builds an RWFP2 pack. Hasheous platforms are discovered dynamically from the dump's top-level directories - no static allowlist gates them. `KNOWN_PLATFORM_PROFILES` and `CURATED_ALIASES` only add media-profile and alias hints for known names; an unknown platform still builds, with the default `nointro-single-image-v1` profile.

The sources never mix inside one platform, and an OpenGood platform in the dump is excluded from Hasheous discovery. The reasoning lives in [Where identify data comes from](../explanation/identify-sources.md).

## Catalog

The builder writes `catalog.json` (format `rom-weaver-identify-catalog-v1`) next to the packs. Each platform entry records the canonical name, aliases, source, media profiles, pack slug, pack format, pack SHA-256, and canonicalization version. `generated` records the pinned OpenGood revision and the dump's file name, SHA-256, and size.

Aliases match case-insensitively after normalizing: lowercase, collapse non-alphanumerics to one space, trim. A platform's own normalized name beats another platform's curated alias; a duplicate alias or pack slug across two platforms is a build error.

## RWFP2 packs

RWFP2 reuses RWFP1's outer container layout with magic `RWFP2\0\0\0`. Members, in directory order: `games.json` (game records with per-component hashes, sizes, roles, and track numbers), `route.bin` (a CRC32+size routing index over discriminating components), `refs.bin` (routed key to game/component references), and `manifest.json` (format, platform, source, canonicalization profile, provenance, and counts). Only components that are discriminating, have a CRC32, and have a nonzero size get routed. The Rust reader dispatches on magic, so RWFP1 parsing is untouched; both `--database` and installed packs accept either format.

## Shared tracks

Byte-identical components that appear under more than one game - overwhelmingly shared CD audio tracks such as silence and standard pre-gaps - are handled per format. RWFP1 drops them by default (`--keep-shared` keeps them). RWFP2 always keeps them in `games.json`, marked `discriminating: false`, and excludes them from `route.bin`: they can support a match but never pick a game alone.

## Determinism

The same inputs produce byte-identical packs. Games sort by (platform, name), components by ordinal, routing records by (CRC32 bytes, size), and discovered platforms alphabetically. Duplicate routing keys are a build error.

## Provenance

Every output records where it came from. `catalog.json` pins the OpenGood revision and the dump's SHA-256; each RWFP2 `manifest.json` carries the same provenance for its own platform; `index.json` records each pack's size and SHA-256. The CLI's `identify database import-hasheous` writes the same shape into the user's database directory and merges its `catalog.json` with the entries of platforms the import did not touch.

## Local Hasheous data

The Hasheous dump's aggregated DAT data does not state redistribution rights. Do not commit Hasheous-derived packs; keep them local. ([Where identify data comes from](../explanation/identify-sources.md#licensing) explains the distinction from the Hasheous software's own AGPL licence.)

Users install packs with `rom-weaver identify database import-hasheous <MetadataMap.zip>`; the recipes are in [Identify and hash ROMs from the CLI](../how-to/identify-and-hash-files.md). For development, build packs directly:

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
