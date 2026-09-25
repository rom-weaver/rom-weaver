# What rom-weaver supports

rom-weaver works with game files you already have. It can change them, make them smaller, identify them, and test supported games.

The browser needs no account or installation. The CLI is the terminal version, useful for scripts and large jobs. Both process files on your device.

<!-- START doctoc -->
## Table of contents

- [Change a game](#change-a-game)
- [Check and prepare files](#check-and-prepare-files)
- [Play and manage saves](#play-and-manage-saves)
- [App and automation](#app-and-automation)

<!-- END doctoc -->

## Change a game

| Feature | In plain words | Browser guide | CLI guide |
| --- | --- | --- | --- |
| Apply patches | Combine your game with someone else's changes, such as a translation. | [Apply](../how-to/apply-rom-patches.md) | [Apply](../how-to/cli-apply.md) |
| Create patches | Compare an original file with your edited file to make a patch. | [Create](../how-to/create-rom-patches.md) | [Create](../how-to/cli-create.md) |
| Ordered patches | Run several changes in order, with input and output checks when available. | [Patch order](../how-to/apply-rom-patches.md#put-several-patches-in-order) | [Patch chains](../how-to/cli-apply.md) |
| Cheat codes | Bake supported codes into a ROM, or turn them into a patch. | [Cheats](../how-to/use-browser-cheats.md) | [Cheats](../how-to/bake-cheat-codes.md) |
| Patch bundles | Package patches with their order, names, choices, and expected ROM checks. | [Bundles](../how-to/create-bundles.md) | [Bundles](../how-to/cli-bundles.md) |

Applying and creating have different format limits. The [patch format table](formats.md#patch-formats) lists both, including the specialized Dreamcast DCP workflow.

Cheat support covers writes to the ROM. Codes that need live game memory cannot be baked. The [cheat reference](cheat-database.md) lists supported systems and matching limits.

## Check and prepare files

| Feature | In plain words | Browser guide | CLI guide |
| --- | --- | --- | --- |
| Identify | Match a file's fingerprint to a known game, region, and revision. Search by name or checksum without a file, too. | [Identify](../how-to/identify-roms-browser.md) | [Identify](../how-to/identify-and-hash-files.md) |
| Checksums | Calculate a fingerprint to compare two files, even if their names differ. | [Read Checks](../how-to/identify-roms-browser.md#compare-a-checksum) | [Hash files](../how-to/identify-and-hash-files.md#hash-a-file) |
| Extract | Take a ROM out of an archive or compressed container. Nested archives are supported. | [Extract a ROM](../how-to/convert-roms-browser.md) | [Extract files](../how-to/work-with-archives.md#extract-an-archive) |
| Compress and convert | Put a ROM into a smaller container, or change its container. This does not port a game to another console. | [Convert a ROM](../how-to/convert-roms-browser.md) | [Archives and disc images](../how-to/work-with-archives.md) |
| Trim | Remove padding from supported files. Padding is space around the useful data. | [Trim](../how-to/trim-roms-browser.md) | [Trim and restore padding](../how-to/cli-trim.md) |
| Headers and byte order | Handle supported dump layouts so patches receive the bytes they expect. | [Resolve layout differences](../how-to/fix-checksum-errors.md#cartridge-header-differences) | [Header options](cli.md#header-and-byte-order-flags) |
| PPF undo | Restore bytes saved inside a PPF3 patch that includes undo data. | [Undo PPF](../how-to/undo-ppf-browser.md) | [Tools](cli.md#tools) |

The browser's archive workflow selects a ROM. The CLI also extracts general archive contents and creates archives from directories.

The [format reference](formats.md) owns the complete container, codec, checksum, trim, and header tables. Reading a format does not imply creating it.

## Play and manage saves

| Feature | In plain words | Availability |
| --- | --- | --- |
| Test a ROM | Play a supported game or check a patched result with the built-in emulator. | [Browser only](../how-to/test-roms-in-browser.md); [supported systems](formats.md#browser-emulator-support) |
| Store and export emulator saves | Keep progress in this browser and download a backup for another device. | [Browser only](../how-to/test-roms-in-browser.md#export-and-restore-a-save) |
| Edit a game save | Change supported properties in the game's saved progress, then download a separate copy. | [Browser](../how-to/edit-gen3-saves.md) and [CLI](../how-to/cli-save.md) |
| Create a game save | Make a fresh supported save, or use an existing save as a template. | [Browser](../how-to/create-game-saves-browser.md) and [CLI](../how-to/create-game-saves-cli.md) |

The [Save Editor reference](save-editor.md) lists the exact games, layouts, fields, and generation limits. A game save and an emulator save state are different files. The editor does not edit save states.

Patching support, emulator support, cheat support, and save editing support are separate. A console can have patch support without a browser emulator or save editor.

## App and automation

| Feature | Support and limits |
| --- | --- |
| Offline use | Cached app files, databases, and emulator cores work offline. Remote links and uncached assets need a connection. [Offline setup](../how-to/browser-settings.md#prepare-for-offline-use). |
| Browser preferences | Theme, accent, language, byte units, guided help, output defaults, compression settings, and worker threads. [Settings](../how-to/browser-settings.md). |
| Beta tools | Trim, PPF Undo, Save Editor, and cheat-code creation in Create are behind the browser's beta setting. Apply cheat steps are available without it. |
| Scripts and pipelines | The CLI has file selection, dry runs, standard input/output, JSON results, JSON event streams, shell completions, and man pages. [CLI reference](cli.md). |
| Hosting and integration | Static or Docker hosting, subpaths, URL-loaded ROMs and patches, bundles, and same-origin file integration. [Hosting](../hosting/self-hosting.md), [integration](../hosting/webapp-integration.md). |

There is no account, cloud synchronization, or ROM download library. The supplied practice files are homebrew samples. [Privacy](../legal/privacy.md) lists storage and network behavior.
