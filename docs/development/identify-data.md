# ROM identify data

ROMWeaver builds deterministic RWFP1 packs from pinned Libretro and OpenGood data. Native packages and the webapp use the same Brotli assets.

<!-- START doctoc -->
## Table of contents

- [Build-time data](#build-time-data)
- [Source policy](#source-policy)
- [RWFP1 records](#rwfp1-records)
- [Checksum router](#checksum-router)
- [Title index](#title-index)
- [Browser installation](#browser-installation)
- [Native installation](#native-installation)
- [Cheat shards](#cheat-shards)
- [Determinism and provenance](#determinism-and-provenance)
- [Pack integrity](#pack-integrity)

<!-- END doctoc -->

## Build-time data

The repository does not commit generated packs. `scripts/build-identify-index.mjs` pins both source commits and fetches only files from those commits.

Build the data:

```bash
mise run identify-data
```

Force a source refresh:

```bash
node scripts/ensure-identify-data.mjs --force
```

The raw output lives under `crates/rom-weaver-cli/data/identify/v1`. Git ignores this directory.

## Source policy

Libretro is the primary source. OpenGood supplies only hash keys that Libretro does not contain.

The deduplication key contains the hash algorithm, normalized hash, file size, and hash scope. An overlap keeps one lookup record and both provenance entries. The OpenGood name takes precedence, with other names retained as alternatives. Headered and headerless OpenGood records also join by their exact source name when that name identifies one record. Display normalization does not add another merge rule.

OpenGood-only records use `legacyVariant: true`. Their `dumpTags` preserve the GoodTools status tokens.

## RWFP1 records

Every built-in and imported pack uses RWFP1. The reader accepts only RWFP1.

RWFP1 stores strings, hashes, components, games, owners, routes, and sets in variable-width binary tables. Hash sizes and sorted owner IDs use deltas. Count-prefixed lists replace cumulative offsets. Components and routes refer to one shared hash record.

The pack manifest owns the platform and source. Game records do not repeat them. Component ordinals are their positions in each game and are reconstructed during decoding.

`manifest.json` stores the source, license, commit, URL, and generation metadata.

## Checksum router

`checksum-routes.bin` (format RWCR1) holds one binary fuse filter per pack, built in the same run as the packs from the same hash rows. A filter stores 8-bit fingerprints of each crc32, md5, and sha1 key in its pack. It stores no checksum value and no game record.

The browser uses the router when it identifies a bare checksum. Each pack filter answers "maybe" or "definitely not" for the digest; the browser loads the union of the "maybe" packs, and the pack lookup gives the final answer. A key present in a pack always routes to that pack, so a key that is in several packs routes to all of them. A pack that does not hold the key answers "maybe" about once in 256 queries, which costs one extra pack fetch and a genuine no-match from that pack.

`index.json` records the router under `checksumRoutes` with its size and SHA-256. Construction uses a fixed seed sequence, so a rebuild over the same keys is byte-identical. The shared builder and reader live in `packages/rom-weaver-webapp/src/lib/identify/checksum-router.mjs`.

The router is browser data only. The native CLI searches every installed pack for a bare checksum, and `scripts/build-identify-release-data.mjs` removes `checksumRoutes` from every release index.

## Title index

`title-index.json` holds every pack's base game titles in one file, so a name search covers all platforms without loading a pack and without the reader choosing a platform first. A base title is a game name with its first ` (` or ` [` tag group and everything after it removed, so the regional and dump-tag variants of one game collapse into a single row.

The file is JSON: a sorted array of pack slugs and an array of `[displayName, [packIndex, ...]]` rows, ordered by the normalized title then the display name. Normalization lowercases, folds accented Latin letters to ASCII, and collapses every run of non-alphanumeric characters into one space - the same rules as the CLI name search in `crates/rom-weaver-cli/src/identify_name_search.rs`. A title that several packs hold carries one row naming every pack.

Known trailing articles move to the front in display labels, including English, French, Spanish, Italian, German, and Dutch forms. For example, `Aktienspiel, Das` displays as `Das Aktienspiel`, and `Legend of Zelda, The` displays as `The Legend of Zelda`. The title index groups these labels for search navigation. Source records and their checksum-specific release choices remain separate under the source policy above.

The index stores base titles only. One row per game record would be 5.4 MB Brotli against 1.6 MB for base titles; the regional variants of a chosen title come from that platform's pack.

A search requires every query token to match. Literal matches rank before numeral aliases, which rank before spelling corrections. Standalone Roman numerals `I` through `XX` and decimal numbers `1` through `20` act as search aliases in titles and alternate names. These numeral tokens require whole-word matches; platform names and dump tags do not use numeral aliases. Case does not affect matching. The index keeps `Final Fantasy IV` and `Final Fantasy 4`, or `Mega Man X` and `Mega Man 10`, as separate title choices. The shared Rust scorer in `crates/rom-weaver-cli/src/identify_name_search.rs` ranks corrections by edit distance and also serves searches over installed packs.

The distance is optimal string alignment (restricted Damerau–Levenshtein). An insertion, deletion, substitution, or adjacent letter swap counts as one edit. Words of four to six characters allow one edit; longer words allow two. Spelling correction does not apply to shorter words or tokens containing numbers. Total edit distance ranks before word position and title length. At equal distance, literal token matches rank before aliases. A search over installed packs then prefers good dumps. A record is a good dump when no tag names a lesser one: a `!` tag, no tags at all, or only tags outside the GoodTools quality codes (`[C]`, `[BF]`). The title index holds base titles without tags, so this rule does not apply there.

`index.json` records the file under `titleIndex` with its size, SHA-256, title count, and pack count. The ordering is fixed, so a rebuild over the same titles is byte-identical. The shared builder and reader live in `packages/rom-weaver-webapp/src/lib/identify/title-index.mjs`.

The browser verifies and stages the index for the WASM `identify --name --title-index` command. Rust validates its rows and returns scored base titles with pack slugs; the browser maps those slugs to platform labels. All matches remain available through the result list's More button. JavaScript does not score names.

The native CLI can read an explicit title-index file through the same command. Packaged CLI data does not include that index: `scripts/build-identify-release-data.mjs` removes `titleIndex` from every release index.

## Browser installation

The web build emits each pack as a Brotli static asset. The service worker precaches `index.json` and `catalog.json` with the app under one service-worker revision. Packs, the checksum router, and the title index are not precached: the background warm-up downloads the default group, which includes the router and the title index, and the optional groups the user has ticked in Settings.

The Settings page can install a complete optional group. The service worker checks every pack before it marks the group as installed.

Computer systems and DOS use the `optional-computers` group. MicroW8, PICO-8, TIC-80, and WASM-4 use the `optional-fantasy` group. LowRes NX remains in the default group.

An identify run that needs a pack outside the installed groups fetches that single pack on demand and caches it. The service worker verifies its SHA-256 before it stores it.

## Native installation

`scripts/build-identify-release-data.mjs` copies each verified Brotli pack into the native release tree. It wraps that tree in a Brotli-compressed tar archive and creates one default archive plus one archive for each optional group. With `--tree-only` it writes the trees and skips the archives; CI uses that on every platform runner, because the archive step needs GNU tar.

Release archives, npm platform packages, Homebrew, Scoop, and container images install the same static tree under `share/rom-weaver/identify/v1`. The CLI decompresses only the packs it reads.

The default `bundled-identify-data` feature enables the packaged default data. Builds without it ignore packaged packs.

`identify database install-group` downloads or imports one optional group. It merges the group into the local database. It does not remove other installed groups.

## Cheat shards

The same build writes one cheat shard per platform in `CHEAT_PLATFORMS` (`scripts/import-libretro-cheats.mjs`). It extracts that platform's `cht/` directory from the pinned Libretro archive, matches each `.cht` file title against the platform's parsed release list, and writes `cheats-<slug>.json` plus a Brotli copy next to the packs.

Before it writes a shard, the importer drops every record that can never bake: structured RetroArch entries, empty or placeholder codes, and codes whose literal address is provably runtime memory for that system. A record is dropped only when every one of its subcodes is provably unbakeable; Game Genie forms are kept, because only the Rust decoder can resolve their address against the ROM. A game with no remaining cheats is dropped. A platform whose filtered game list is empty fails the build; remove that platform from `CHEAT_PLATFORMS`.

The file stores each record once, without the values a reader derives (`id`, `system`, `gameId`, `sourceRevision`, the repeated `desc`/`code`/`enable` raw fields, and the source file name). `packages/rom-weaver-webapp/src/lib/cheats/shard-format.mjs` owns that layout: the builder calls its `storeCheat`, the browser worker calls its `expandCheatShard`, and `crates/rom-weaver-cli/src/cheat_database.rs` ports the expansion for the CLI. The record ID is a SHA-256 over the restored fields, so all three MUST agree byte for byte; the Rust unit tests pin IDs the JavaScript reference produced. `ensure-identify-data.mjs` checks every shard's leading bytes against the current schema version and Libretro revision, so a data directory an older builder wrote is rebuilt even when the index still matches its files. The reference page documents the layout: [Shard file](../reference/cheat-database.md#shard-file).

`index.json` lists each remaining shard under `cheats` with its platform, slug, Rust `cheatSystem` identifier, size, SHA-256, and pack group. `sources.libretro.licenseFile` names the copied license text.

The webapp stages shards as `assets/identify-cheats-<slug>.json` sidecars, serves them through the identify pack route, and adds them to their platform's pack group. The release tree stores them under `cheats/<slug>.json.br`; `identify database install-group` copies them beside the packs, and `identify database remove` deletes them with the pack.

To add a platform, add a `CHEAT_PLATFORMS` entry whose key is an identify platform name and whose `cheatSystem` is a Rust `CheatSystem` identifier. Every cheat platform needs a Rust `CheatSystem` decoder.

## Determinism and provenance

Inputs, games, components, provenance, tags, routes, and output files use stable sorting. The source refresh date is pinned with the source revisions.

Each manifest records the source name, URL, commit, license, input path, and generation date. `index.json` records each pack size and SHA-256.

## Pack integrity

The browser and native CLI check each pack size and SHA-256 before use. The reader also checks every member, table length, offset, hash width, and reference. The browser applies the same size and SHA-256 checks to the checksum router, and the router reader checks every slug, segment layout, and table length.

An invalid or absent pack reports identification as unavailable. It does not become a false no-match result.
