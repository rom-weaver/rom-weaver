# Where identify data comes from

`identify` matches a file's checksums against title databases. This page explains which database answers for which system, what each result status and quality means, and why some data ships with the tool while other data must stay on your machine. Nothing here is a procedure; the recipes are in [Identify and hash ROMs from the CLI](../how-to/identify-and-hash-files.md).

<!-- START doctoc -->
## Table of contents

- [Two sources, one per system](#two-sources-one-per-system)
- [What a result means](#what-a-result-means)
- [Why a matched disc can still be "partial"](#why-a-matched-disc-can-still-be-partial)
- [Shared audio tracks](#shared-audio-tracks)
- [Licensing](#licensing)
- [Nothing leaves your machine](#nothing-leaves-your-machine)
- [Related](#related)

<!-- END doctoc -->

## Two sources, one per system

Identify data comes from exactly two places, and every system belongs to exactly one of them:

- [OpenGood](https://github.com/SnowflakePowered/opengood) covers 17 cartridge systems. It is CC0, so its packs ship inside the tool and work offline with no setup.
- [Redump](http://redump.org/) covers 56 optical-media systems. Its public DAT files become set-aware packs that the browser can download and cache.

The sources never mix inside one system. An OpenGood system that returns no match stays unmatched; it never falls through to Redump. This keeps each answer traceable to one dataset. A "no match" means that the selected dataset does not know the file.

## What a result means

The `status` field says how many titles matched:

- **matched** - exactly one title.
- **ambiguous** - more than one title fits the same evidence.
- **unknown** - none.

For set-aware databases, `quality` says how completely the match was proven:

- **exact** - every required component of the title matched, and nothing unexpected was left over.
- **partial** - at least one discriminating component matched, but some required components are missing or unexpected extras exist.
- **metadata_only** - the database describes the title but carries no hashes strong enough to prove it from your file.

An `unknown` status can carry a `condition` that explains itself:

- **database_required** - the detected platform needs a pack that is not installed. The result's `hint` names the pack to install; this is an actionable gap, not a failed lookup.
- **unsupported_media_profile** - the platform's database stores canonical per-track hashes, but the input was hashed as one payload the tool cannot map onto them. Today this means a whole-disc single-blob image checked against a redump-style CD or GD-ROM track database.

`platform_candidates` lists the platforms detection considered, each with a confidence and the evidence behind it - a header magic, a disc serial, a file-name hint, or your own override.

## Why a matched disc can still be "partial"

A CD or GD-ROM title is a set of tracks, and the database knows the whole set. rom-weaver currently identifies CUE, GDI, and CHD inputs per selected payload track, not as a complete set. One matched data track proves a lot - data tracks are almost always unique to a title - but it does not prove the audio tracks are present and correct. So a single matched data track reports quality `partial`, and the result's evidence counts how many required components went unverified. Full set verification is the direction, not the current state.

## Shared audio tracks

Many CDs share byte-identical audio tracks: silence, standard pre-gaps, licensed jingles. The databases keep these tracks, but mark them non-discriminating. A non-discriminating track can support a match that a data track established, but it can never identify a title alone - otherwise every disc containing two seconds of silence would "match" hundreds of games. A file that matches only non-discriminating tracks reports `unknown`.

## Licensing

Both sources allow redistribution:

- OpenGood data is CC0-1.0. It can be bundled, redistributed, and shipped in releases, so it is.
- Redump states that its contributed metadata is public information. rom-weaver distributes derived packs and records their exact DAT source.

Every built pack records where it came from: its source, the upstream revision, and the SHA-256 of the dump it was built from. [ROM identify data](../development/identify-data.md) documents the build details.

## Nothing leaves your machine

Native identify downloads a Redump DAT only when you run a database install or update command. Identification reads local packs and sends no ROM data. The browser downloads packs from rom-weaver's own site and verifies each SHA-256 value. Your files stay on the device.

## Related

- [Identify and hash ROMs from the CLI](../how-to/identify-and-hash-files.md): the recipes.
- [CLI reference](../reference/cli.md#identify): every flag, subcommand, and result field.
- [ROM identify data](../development/identify-data.md): how the packs are built.
- [Why your files stay on your device](local-first.md): the local-first model.
