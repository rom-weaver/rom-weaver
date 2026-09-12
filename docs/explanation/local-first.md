# Why your files stay on your device

rom-weaver is a local-first tool. The webapp is a program your browser downloads and then runs on your own machine, not a service you upload files to. This page explains what that means in practice and where the limits are.

<!-- START doctoc -->
## Table of contents

- [Nothing is uploaded](#nothing-is-uploaded)
- [Where files live while a job runs](#where-files-live-while-a-job-runs)
- [Your original is never modified](#your-original-is-never-modified)
- [What this costs you](#what-this-costs-you)
- [Offline](#offline)
- [Related](#related)

<!-- END doctoc -->

## Nothing is uploaded

Reading, checksumming, patching, compressing, and writing all happen inside your browser tab, on your device. The hosted site sends you app code and normal web assets. The files you choose never travel back.

The patching engine is compiled to WebAssembly and runs in your browser's workers. There is no server-side patching endpoint for your files to go to, and no account to attach them to.

Remote bundles and their sources are downloaded from their hosts. Identify packs and emulator cores are downloaded as app assets when needed. These downloads do not upload your local files.

## Where files live while a job runs

Large intermediate files are written to browser-managed local storage while a job runs, because a multi-gigabyte disc image does not fit in memory. That storage belongs to your browser and stays on your disk. **Reset** clears the current workbench.

[Privacy](../legal/privacy.md) documents browser storage, logs, analytics, and every network request the site makes.

## Your original is never modified

The browser reads your selected files and produces a separate result. It does not modify the selected input.

The CLI can modify files when explicitly requested: `trim --in-place` rewrites its source, and `--force` permits overwriting an existing output. [Trim a ROM from the CLI](../how-to/cli-trim.md) documents those choices. A preserved clean original remains useful for later patches.

## What this costs you

The webapp targets the last two major versions of Chrome, Edge, Firefox, Safari, and iOS Safari. These browsers still impose limits:

- **Memory and storage are the browser's, not the machine's.** A browser tab can run out of room on a large disc image long before your computer would.
- **Capabilities vary by browser.** Threaded WebAssembly, large-file storage, and installable app support are not uniform. The site reports what it found in the masthead - see [Webapp runtime status](../hosting/webapp-runtime-status.md).
- **Nothing is shared between devices.** There is no account or built-in synchronization.

When a browser cannot finish a large job, the CLI is the same engine without the browser's limits. [Browser and CLI](browser-and-cli.md) covers the choice.

## Offline

Cached app code and local files can be used offline. Uncached identify packs, emulator cores, sample files, and remote bundle sources still need a connection. Browser storage eviction can remove cached assets. [Test a ROM](../how-to/test-roms-in-browser.md) covers preparing the emulator for offline use.

## Related

- [Privacy](../legal/privacy.md) for the detailed statement.
- [Self-hosting](../hosting/self-hosting.md) if you would rather serve the app yourself.
