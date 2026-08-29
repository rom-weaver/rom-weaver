# ROM identify data

ROMWeaver builds deterministic RWFP4 packs from pinned Libretro and OpenGood data. Native packages use Zstandard assets. The webapp uses Brotli assets.

<!-- START doctoc -->
## Table of contents

- [Build-time data](#build-time-data)
- [Source policy](#source-policy)
- [RWFP4 records](#rwfp4-records)
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

## RWFP4 records

RWFP4 is the only supported pack format.

RWFP4 stores strings, hashes, components, games, owners, routes, and sets in binary tables. Components and routes refer to one shared hash record. Provenance exists once per pack and each game refers to a provenance set.

`manifest.json` stores the source, license, commit, URL, and generation metadata.

## Browser installation

The web build emits each pack as a Brotli static asset. The service worker precaches only the default groups during installation.

The Settings page can install a complete optional group. The service worker checks every pack before it marks the group as installed.

Computer systems and DOS use the `optional-computers` group. MicroW8, PICO-8, TIC-80, and WASM-4 use the `optional-fantasy` group. LowRes NX remains in the default group.

Identify requests use the local caches only. A cache miss returns a local error. It does not fetch a pack in response to ROM data.

## Native installation

`scripts/build-identify-release-data.mjs` writes each pack as Zstandard. It creates one default archive and one archive for each optional group.

Release archives, npm platform packages, Homebrew, Scoop, and container images install the same static tree under `share/rom-weaver/identify/v1`. The CLI decompresses only the packs it reads.

The default `bundled-identify-data` feature enables the packaged default data. Builds without it ignore packaged packs.

`identify database install-group` downloads or imports one optional group. It merges the group into the local database. It does not remove other installed groups.

## Determinism and provenance

Inputs, games, components, provenance, tags, routes, and output files use stable sorting. The source refresh date is pinned with the source revisions.

Each manifest records the source name, URL, commit, license, input path, and generation date. `index.json` records each pack size and SHA-256.

## Pack integrity

The browser and native CLI check each pack size and SHA-256 before use. The reader also checks every member, table length, offset, hash width, and reference.

An invalid or absent pack reports identification as unavailable. It does not become a false no-match result.
