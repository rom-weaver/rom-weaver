# Extract, convert, and compress archives

Open a ZIP, 7z, RAR, tar, or single compressed file from the terminal, get
what you need out of it, and repackage it as ZIP or 7z. To patch a ROM that is
inside an archive, no extraction is needed in either front end: add the
archive as the input and rom-weaver looks inside, as covered in
[Apply a ROM patch](apply-rom-patches.md) and
[Apply patches from the CLI](cli-apply.md).

<!-- START doctoc -->
## Table of contents

- [Extract an archive](#extract-an-archive)
- [Convert one archive format to another](#convert-one-archive-format-to-another)
- [Create a ZIP or 7z](#create-a-zip-or-7z)
- [Compress a ROM or disc image instead](#compress-a-rom-or-disc-image-instead)
- [Look up what is supported](#look-up-what-is-supported)

<!-- END doctoc -->

## Extract an archive

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
Z3DS, or a trim rather than a ZIP:

```sh
rom-weaver compress --input disc.cue --output disc.chd
```

See [Choosing a compression format](../explanation/compression-formats.md) for
which container fits which platform and when trimming beats compressing.

## Look up what is supported

[Supported formats](../reference/formats.md#container-and-compression-formats)
is the authoritative table: every container, its aliases and extensions,
whether rom-weaver can probe, extract, or create it, and the `--codec` values
each output accepts. It covers the specialized disc and ROM containers this
page leaves out.
