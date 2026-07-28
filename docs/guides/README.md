# Use rom-weaver

rom-weaver is a local-first browser app and command-line toolkit for applying,
creating, inspecting, and packaging ROM patches. Start with the workflow you
need; your ROMs and disc images stay on your device.

<!-- START doctoc -->
## Table of contents

- [Choose a workflow](#choose-a-workflow)
- [Start in the browser](#start-in-the-browser)
- [Use the CLI](#use-the-cli)
- [Before working with a real patch](#before-working-with-a-real-patch)
- [Get more detail](#get-more-detail)
- [Project information](#project-information)

<!-- END doctoc -->

## Choose a workflow

- [Apply ROM patches](apply-rom-patches.md) explains how to combine a clean
  base ROM with one or more patches in the webapp or CLI.
- [Create a ROM patch](create-rom-patches.md) turns an original file and your
  modified file into a distributable patch.
- [Fix checksum errors](fix-checksum-errors.md) covers regions, revisions,
  copier headers, Nintendo 64 byte order, and patch order.
- [Choose a patch format](patch-formats.md) compares the formats people most
  often encounter and links to the complete support matrix.

## Start in the browser

Open [rom-weaver.com/weave](https://rom-weaver.com/weave). No account or
installation is required. Choose **Weave** to apply patches or **Create** to
make one. rom-weaver reads and writes the files locally in your browser instead
of uploading them to a patching service.

If you want a safe first run, open the
[sample weave](https://rom-weaver.com/weave?bundle=first-weave.zip). It uses
tiny synthetic files supplied by the project, so you can learn the controls
without selecting any personal files.

The browser app can also be installed as a Progressive Web App from your
browser menu. Once its assets are cached, the installed app can run offline.

## Use the CLI

The CLI exposes the same core patching engine for repeatable workflows and
scripts. Install it with Homebrew, Scoop, the release installer, npm, Cargo, or
Docker. The [complete CLI guide](../cli.md) documents every installation path,
command, option, supported format, and exit code.

After installation, confirm the command is available:

```bash
rom-weaver --help
```

Run the project's synthetic sample:

```bash
curl --fail --location --output first-weave.zip \
  https://rom-weaver.com/first-weave.zip
rom-weaver weave --input first-weave.zip --output woven.bin --no-compress
rom-weaver checksum --input woven.bin --algo sha256
```

The final SHA-256 should be
`43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb`.

## Before working with a real patch

Read the patch author's instructions first. Record the required game region,
revision, header state, disc layout, patch order, and source checksum. A
filename is only a hint: two files with the same name can contain different
bytes.

Keep one clean, read-only copy of the original. Save patched results under new
names, and only use ROMs or disc images you are permitted to use. rom-weaver
does not provide copyrighted game data.

## Get more detail

The focused guides here cover the common path from a clean input to a verified
output. For scripting, archive selection, compression, bundles, JSON output,
and the full command reference, continue to the
[CLI guide](../cli.md). For deployment and integration, return to the
[documentation index](../README.md).

## Project information

- [Notices](notices.md) explains the project license and links to the generated
  attribution inventories included with each build.
- [Privacy](privacy.md) describes local file processing, browser storage,
  network requests, and the controls available to you.
