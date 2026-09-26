# rom-weaver documentation

rom-weaver changes, checks, compresses, and tests game files you already have. Your files stay on your device.

[What rom-weaver supports](reference/features.md) explains every feature in plain words, with links to exact support limits.

These pages are organised by what you need right now: learning, doing, looking up, or understanding.

<!-- START doctoc -->
## Table of contents

- [New here?](#new-here)
- [Choose a task](#choose-a-task)
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

Start in the browser. No account, installation, or commercial game is needed for the practice run.

1. Follow [your first patch](tutorials/first-patch.md) with the supplied homebrew files.
2. Check the result against the tutorial's checksum.
3. Choose your own task below. Keep a clean backup of your files.

Prefer the terminal? Start with [Install the CLI](how-to/install-cli.md), then [your first CLI apply](tutorials/cli-first-weave.md).

Guided app samples: [Apply](https://rom-weaver.com/apply-patches?guide=apply), [Create](https://rom-weaver.com/create-patch?guide=create), and [Bundle](https://rom-weaver.com/bundle-patches?guide=bundle).

## Choose a task

| I want to… | Browser guide |
| --- | --- |
| Add a translation or other game change | [Apply a patch](how-to/apply-rom-patches.md) |
| Share changes I made | [Create a patch](how-to/create-rom-patches.md) or [bundle a recipe](how-to/create-bundles.md) |
| Find which game or revision a file contains | [Identify and compare checksums](how-to/identify-roms-browser.md) |
| Take files out of an archive | [Extract files](how-to/extract-files-browser.md) |
| Make a game's file smaller or change its container | [Convert or compress](how-to/convert-roms-browser.md), or [trim padding](how-to/trim-roms-browser.md) |
| Use cheat codes | [Add cheats](how-to/use-browser-cheats.md) |
| Play a game or back up progress | [Test a ROM](how-to/test-roms-in-browser.md) |
| Change saved progress | [Edit a save](how-to/edit-gen3-saves.md) or [create a fresh save](how-to/create-game-saves-browser.md) |
| Work without an internet connection | [Set up offline use](how-to/browser-settings.md#prepare-for-offline-use) |

For terminal equivalents and availability limits, use the [feature map](reference/features.md).

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
- [Identify a ROM and compare checksums](how-to/identify-roms-browser.md)
- [Extract files from an archive or disc image](how-to/extract-files-browser.md)
- [Extract, convert, or compress a ROM](how-to/convert-roms-browser.md)
- [Trim a ROM](how-to/trim-roms-browser.md)
- [Undo a PPF patch](how-to/undo-ppf-browser.md)
- [Test a ROM in the browser](how-to/test-roms-in-browser.md)
- [Fix a checksum error](how-to/fix-checksum-errors.md)
- [Edit a game save](how-to/edit-gen3-saves.md)
- [Create game saves in the browser](how-to/create-game-saves-browser.md)
- [Settings, beta tools, and offline use](how-to/browser-settings.md)

### From the terminal

- [Install the CLI](how-to/install-cli.md)
- [Verify a download](how-to/verify-downloads.md)
- [Apply patches from the CLI](how-to/cli-apply.md)
- [Create patches from the CLI](how-to/cli-create.md)
- [Bundles from the CLI](how-to/cli-bundles.md)
- [Identify and hash files](how-to/identify-and-hash-files.md)
- [Bake cheat codes into a ROM](how-to/bake-cheat-codes.md)
- [Edit a game save from the CLI](how-to/cli-save.md)
- [Create game saves with the CLI](how-to/create-game-saves-cli.md)
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
- [What rom-weaver supports](reference/features.md): every feature in plain words, browser and CLI availability, and links to exact limits.
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
