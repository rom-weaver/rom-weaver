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

This is not a policy promise that could quietly change - it is how the app is built. The patching engine is compiled to WebAssembly and runs in your browser's workers. There is no server-side patching endpoint for your files to go to, and no account to attach them to.

The one exception is a file you explicitly point at over the network: a bundle loaded from a URL has to be fetched from wherever it is hosted. Your local files are still local.

## Where files live while a job runs

Large intermediate files are written to browser-managed local storage while a job runs, because a multi-gigabyte disc image does not fit in memory. That storage belongs to your browser and stays on your disk. **Reset** clears the current workbench.

[Privacy](../legal/privacy.md) documents browser storage, logs, analytics, and every network request the site makes.

## Your original is never modified

rom-weaver writes a new file. The webapp hands you a download; the CLI writes to the output path you name. Your input file is read and never written to.

Keep the clean original anyway. Updates and other patches will want it again, and it is the only thing that can rescue a bad run.

## What this costs you

Local-first is a trade, and the browser side of the trade is real:

- **Memory and storage are the browser's, not the machine's.** A browser tab can run out of room on a large disc image long before your computer would.
- **Capabilities vary by browser.** Threaded WebAssembly, large-file storage, and installable app support are not uniform. The site reports what it found in the masthead - see [Webapp runtime status](../hosting/webapp-runtime-status.md).
- **Nothing is shared between devices.** There is no account, so there is no sync. That is the point, but it is still a limitation.

When a browser cannot finish a large job, the CLI is the same engine without the browser's limits. [Browser and CLI](browser-and-cli.md) covers the choice.

## Offline

Because the work is local, the app can run without a network once your browser has cached it. Install it from your browser menu where that is offered, and open the routes you need once while online. Only remote bundle URLs still require a connection.

## Related

- [Privacy](../legal/privacy.md) for the detailed statement.
- [Self-hosting](../hosting/self-hosting.md) if you would rather serve the app yourself.
