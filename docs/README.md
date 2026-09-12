# rom-weaver documentation

rom-weaver applies and creates ROM patches without uploading your files. It runs in your browser with nothing to install, and as a command-line tool for scripts and large jobs.

These pages are organised by what you need right now: learning, doing, looking up, or understanding.

<!-- START doctoc -->
## Table of contents

- [New here?](#new-here)
- [Tutorials](#tutorials)
- [How-to guides](#how-to-guides)
  - [In the browser](#in-the-browser)
  - [From the terminal](#from-the-terminal)
  - [Deploying and integrating](#deploying-and-integrating)
- [Reference](#reference)
- [Explanation](#explanation)
- [Quick answers](#quick-answers)
- [Develop and contribute](#develop-and-contribute)

<!-- END doctoc -->

## New here?

Start in the browser. Nothing to install, your files stay on your device, and the guided tours let you practise on tiny homebrew ROMs before you touch a game you care about.

Take [your first patch](tutorials/first-patch.md), or open a tour directly: [apply two practice patches](https://rom-weaver.com/apply-patch?guide=apply), [build a patch from two ROMs](https://rom-weaver.com/create-patch?guide=create), or [package one as a release](https://rom-weaver.com/apply-patch?guide=bundle).

## Tutorials

Guided practice runs. Follow them start to finish; everything you need is supplied.

- [Your first patch in the browser](tutorials/first-patch.md): patch a homebrew ROM and verify the result byte for byte.
- [Your first apply in the terminal](tutorials/cli-first-weave.md): the same job, plus creating and bundling a patch, from a command line.

## How-to guides

Procedures for specific tasks.

### In the browser

- [Apply a ROM patch](how-to/apply-rom-patches.md)
- [Use cheats in the browser](how-to/use-browser-cheats.md)
- [Create a ROM patch](how-to/create-rom-patches.md)
- [Create and share a patch bundle](how-to/create-bundles.md)
- [Test a ROM in the browser](how-to/test-roms-in-browser.md)
- [Fix a checksum error](how-to/fix-checksum-errors.md)
- [Edit a Generation III save](how-to/edit-gen3-saves.md): inspect and safely edit an English retail Pokémon Ruby, Sapphire, Emerald, FireRed, or LeafGreen game save in the browser.

### From the terminal

- [Install the CLI](how-to/install-cli.md)
- [Verify a download](how-to/verify-downloads.md)
- [Apply patches from the CLI](how-to/cli-apply.md)
- [Create patches from the CLI](how-to/cli-create.md)
- [Bundles from the CLI](how-to/cli-bundles.md)
- [Identify and hash files](how-to/identify-and-hash-files.md)
- [Bake cheat codes into a ROM](how-to/bake-cheat-codes.md)
- [Edit a game save from the CLI](how-to/cli-save.md)
- [Trim a ROM from the CLI](how-to/cli-trim.md)
- [Extract, convert, and compress archives](how-to/work-with-archives.md)
- [Fix a permission error](how-to/fix-permission-errors.md)

### Deploying and integrating

- [Self-hosting](hosting/self-hosting.md): Docker, static deployment, reverse proxies, subpaths, HTTPS, and COOP/COEP.
- [Webapp integration](hosting/webapp-integration.md): preload `?bundle=...` and `?rom=...&patch=...` URLs, or feed same-origin OPFS files into the pipeline.
- [Hosted deployment channels](development/ci.md#deploy-channels): production, beta, nightly, and pull-request previews.

## Reference

Facts to look up. No advice, no steps.

- [Supported formats](reference/formats.md): the full patch, container, codec, checksum, trim, and header support tables.
- [Cheat database](reference/cheat-database.md): supported systems, delivery classes, matching, storage, and licensing.
- [CLI reference](reference/cli.md): every command, global flag, patching flag, JSON output, exit code, and permission check.
- [Save Editor support](reference/save-editor.md): supported games, editable fields, recognition rules, and integrity checks.
- [Man pages](reference/cli.md#man-pages): generate `rom-weaver(1)` and one page per visible command from Clap.
- [`rom-weaver-bundle.json` schema](rom-weaver-bundle-v2.schema.json): the machine-readable bundle format.
- [Runtime configuration](hosting/env-vars.md): environment variables and browser diagnostic handles.
- [Webapp masthead metadata](hosting/webapp-runtime-status.md): version, SHA, thread, PWA, and service-worker labels.

## Explanation

Background on the engine, formats, and design decisions.

- [How ROM patching works](explanation/how-patching-works.md): why the exact starting file matters, what a checksum proves, why order matters, and what every term means.
- [ROM cheats](explanation/rom-cheats.md): why rom-weaver bakes cheats into the ROM instead of running them at emulation time.
- [Why your files stay on your device](explanation/local-first.md): the benefits and limits of local processing.
- [Choosing a patch format](explanation/patch-formats.md): what actually separates BPS, IPS, xdelta, PPF, and the rest.
- [Choosing a compression format](explanation/compression-formats.md): CHD, RVZ, Z3DS, ZIP, 7z, and when trimming beats compressing.
- [What a bundle is](explanation/bundles.md): the portable patch recipe.
- [Browser and CLI](explanation/browser-and-cli.md): one engine, two front ends, and how to pick.
- [Where identify data comes from](explanation/identify-sources.md): Libretro metadata, OpenGood fallback records, and local lookup.
- [Release provenance](explanation/release-provenance.md): what download verification proves and why the checks are shaped the way they are.
- [Comparison with similar tools](explanation/comparisons.md): where rom-weaver overlaps with RomPatcher.js, Flips, MultiPatch, xdelta3, chdman, and Dolphin tool, and which one fits your job.

## Quick answers

- [FAQ](faq.md): common questions, each pointing at the page that owns the answer.
- [Privacy](legal/privacy.md): browser storage, logs, analytics, and network requests.
- [Notices](https://rom-weaver.com/docs/notices): licensing and third-party components.

## Develop and contribute

- [Contribution guide](../CONTRIBUTING.md): reporting bugs, proposing changes, validation, and contribution licensing.
- [Development guide](development/development.md): prerequisites, setup, native and WASM builds, the dev server, tests, generated files, and worktrees.
- [Architecture](development/ARCHITECTURE.md): workspace layout, crate graph, command core, browser boundary, OPFS, workers, and test organization.
- [ROM identify data](development/identify-data.md): rebuild the Libretro and OpenGood packs.
- [Save Editor development](development/save-editor.md): shared handler architecture, integrity boundary, and the eight-step contributor flow.
- [References](development/references.md): format specifications and upstream reference implementations.

- [CI workflows](development/ci.md) and [local CI checks](development/reproduce-ci-locally.md).
- [Commit conventions](development/commits.md) and the [release guide](../.github/RELEASING.md).
- [Performance](development/performance.md), [browser concurrency](development/browser-concurrency.md), and [Mobile Safari verification](development/mobile-safari-verification.md).
- [Vendored code](development/vendor-code.md), [trim footer format](development/trim-revert-footer.md), and [screenshots](development/screenshots.md).
- [CLA](../CLA.md), [code of conduct](../.github/CODE_OF_CONDUCT.md), [security policy](../.github/SECURITY.md), and [commercial licensing](../COMMERCIAL.md).
