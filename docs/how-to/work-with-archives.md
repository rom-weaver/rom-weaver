# Extract, convert, and compress archives

Open a ZIP, 7z, RAR, tar, or single compressed file, get what you need out of
it, and repackage it as ZIP or 7z. Everything runs locally in the browser or
through the CLI; files are not uploaded.

<!-- START doctoc -->
## Table of contents

- [Patch a file that is inside an archive](#patch-a-file-that-is-inside-an-archive)
- [Extract an archive from the CLI](#extract-an-archive-from-the-cli)
- [Convert one archive format to another](#convert-one-archive-format-to-another)
- [Create a ZIP or 7z](#create-a-zip-or-7z)
- [Compress a ROM or disc image instead](#compress-a-rom-or-disc-image-instead)
- [Look up what is supported](#look-up-what-is-supported)

<!-- END doctoc -->

## Patch a file that is inside an archive

You do not have to extract it first.

1. Open [Apply](https://rom-weaver.com/apply).
2. Add the archive alongside your patch.
3. When rom-weaver asks, choose the entry the patch author named.

rom-weaver looks inside nested archives too, and unpacks disc containers such
as CHD and RVZ to the form the patch expects. The rest of the run is the normal
[Apply a ROM patch](apply-rom-patches.md) workflow.

## Extract an archive from the CLI

```sh
rom-weaver extract --input patches.7z --output extracted-patches
```

Gzip, Bzip2, XZ, and Zstandard inputs are single compressed streams, so they
extract to their one payload file rather than a directory.

## Convert one archive format to another

There is no single convert command. Extract, then compress the directory:

```sh
rom-weaver extract --input patches.7z --output extracted-patches
rom-weaver compress --input extracted-patches --output patches.zip
```

The new ZIP contains `extracted-patches/` as its top-level directory, because
`compress` archives the paths you give it. It does not unpack an archive input
on your behalf: pass `patches.7z` directly and the new archive will contain the
`patches.7z` file itself.

## Create a ZIP or 7z

```sh
rom-weaver compress --input my-release --output my-release.zip
```

ZIP accepts `store`, `deflate`, or `zstd`; 7z uses LZMA2. Pass `--codec` to
choose, or leave it out for the default. In the browser, the same settings
appear in the output card when the input supports them.

Those two are the only general-purpose archive formats rom-weaver can create.
ZIPX, RAR, TAR and its variants, Gzip, Bzip2, XZ, and Zstandard can be opened
but not written, so converting *into* one of them is not possible - extract and
use a different container.

## Compress a ROM or disc image instead

An archive is not the same thing as a compressed disc image. If your goal is a
smaller file your emulator still boots directly, you probably want CHD, RVZ,
Z3DS, or a trim rather than a ZIP. See
[Choosing a compression format](../explanation/compression-formats.md).

## Look up what is supported

[Supported formats](../reference/formats.md#container-and-compression-formats)
is the authoritative table: every container, its aliases and extensions,
whether rom-weaver can probe, extract, or create it, and the `--codec` values
each output accepts. It covers the specialized disc and ROM containers this
page leaves out.
