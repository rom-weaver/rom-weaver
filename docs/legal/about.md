# About rom-weaver

rom-weaver patches, converts, and bundles ROMs and disc images. It is free and open-source software, it runs the same engine in your browser and on the command line, and it does the work on your own device.

<!-- START doctoc -->
## Table of contents

- [Who makes it](#who-makes-it)
- [Licence](#licence)
- [What it is built on](#what-it-is-built-on)
- [Where your files go](#where-your-files-go)
- [Getting in touch](#getting-in-touch)

<!-- END doctoc -->

## Who makes it

rom-weaver is written by Brandon Casey and the people who send patches to it. The source, the issue tracker, and every release live in one place: [github.com/rom-weaver/rom-weaver](https://github.com/rom-weaver/rom-weaver).

## Licence

rom-weaver is licensed under the [GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0.html). You may use, study, change, and share it. If you run a changed version as a network service, the AGPL asks you to offer that version's source to the people using it.

## What it is built on

The heavy lifting comes from open-source projects — among them nod, libarchive, chd-rs, the 7-Zip LZMA SDK, and xdvdfs — each used under its own licence. The [notices and attribution](/docs/notices) page lists every component that ships in a build, with its licence text.

## Where your files go

Nowhere. Files are read, patched, and written on your device: in your browser by WebAssembly running in background workers, or on your own disk by the CLI. There is no account, and no ROM, patch, or result is uploaded to a rom-weaver server. The [privacy](/docs/privacy) page has the details, including what the app stores locally and what it downloads.

## Getting in touch

Bugs, format requests, and questions belong in [the issue tracker](https://github.com/rom-weaver/rom-weaver/issues). Security reports have [their own process](https://github.com/rom-weaver/rom-weaver/security/policy).
