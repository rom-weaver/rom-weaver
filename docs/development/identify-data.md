# ROM identify data

ROMWeaver builds deterministic RWFP1 packs from pinned Libretro and OpenGood data. Native packages and the webapp use the same Brotli assets.

<!-- START doctoc -->
## Table of contents

- [Build-time data](#build-time-data)
- [Source policy](#source-policy)
- [RWFP1 records](#rwfp1-records)
- [Checksum router](#checksum-router)
- [Browser installation](#browser-installation)
- [Native installation](#native-installation)
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

The deduplication key contains the hash algorithm, normalized hash, file size, and hash scope. An overlap keeps one lookup record, Libretro metadata, and both provenance entries.

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

## Browser installation

The web build emits each pack as a Brotli static asset. The service worker precaches `index.json` and `catalog.json` with the app under one service-worker revision. Packs and the checksum router are not precached: the background warm-up downloads the default group, which includes the router, and the optional groups the user has ticked in Settings.

The Settings page can install a complete optional group. The service worker checks every pack before it marks the group as installed.

Computer systems and DOS use the `optional-computers` group. MicroW8, PICO-8, TIC-80, and WASM-4 use the `optional-fantasy` group. LowRes NX remains in the default group.

An identify run that needs a pack outside the installed groups fetches that single pack on demand and caches it. The service worker verifies its SHA-256 before it stores it.

## Native installation

`scripts/build-identify-release-data.mjs` copies each verified Brotli pack into the native release tree. It wraps that tree in a Brotli-compressed tar archive and creates one default archive plus one archive for each optional group.

Release archives, npm platform packages, Homebrew, Scoop, and container images install the same static tree under `share/rom-weaver/identify/v1`. The CLI decompresses only the packs it reads.

The default `bundled-identify-data` feature enables the packaged default data. Builds without it ignore packaged packs.

`identify database install-group` downloads or imports one optional group. It merges the group into the local database. It does not remove other installed groups.

## Determinism and provenance

Inputs, games, components, provenance, tags, routes, and output files use stable sorting. The source refresh date is pinned with the source revisions.

Each manifest records the source name, URL, commit, license, input path, and generation date. `index.json` records each pack size and SHA-256.

## Pack integrity

The browser and native CLI check each pack size and SHA-256 before use. The reader also checks every member, table length, offset, hash width, and reference. The browser applies the same size and SHA-256 checks to the checksum router, and the router reader checks every slug, segment layout, and table length.

An invalid or absent pack reports identification as unavailable. It does not become a false no-match result.
