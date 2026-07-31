# Extract, convert, and compress archive formats

rom-weaver can inspect and extract libarchive-backed archives and compressed
files, then create ZIP or 7z outputs. Everything runs locally in the browser or
through the CLI; files are not uploaded.

<!-- START doctoc -->
## Table of contents

- [Choose an operation](#choose-an-operation)
- [Supported libarchive inputs](#supported-libarchive-inputs)
- [Create or compress to ZIP and 7z](#create-or-compress-to-zip-and-7z)
- [Extract-only inputs](#extract-only-inputs)

<!-- END doctoc -->

## Choose an operation

Use [Apply](https://rom-weaver.com/apply) in the browser to open a supported
archive while applying patches, or choose ZIP or 7z as the compressed output.
The [CLI](../hosting/cli.md) exposes the same archive handlers directly:

```sh
rom-weaver extract --input patches.7z --output patches
rom-weaver compress --input patches --output patches.zip
```

Extraction and creation are format-aware. A conversion first extracts the
input, then creates a supported output; not every input format can be created
again.

## Supported libarchive inputs

These formats can be opened and extracted:

| Format | Extensions | Extract | Create/compress |
| --- | --- | :---: | :---: |
| ZIP | `.zip` | yes | yes |
| ZIPX | `.zipx` | yes | no |
| 7z | `.7z` | yes | yes |
| RAR | `.rar` | yes | no |
| TAR | `.tar` | yes | no |
| TAR.GZ | `.tar.gz`, `.tgz` | yes | no |
| TAR.BZ2 | `.tar.bz2`, `.tbz2` | yes | no |
| TAR.XZ | `.tar.xz`, `.txz` | yes | no |
| Gzip | `.gz` | yes | no |
| Bzip2 | `.bz2` | yes | no |
| XZ | `.xz` | yes | no |
| Zstandard | `.zst` | yes | no |

Archives can contain nested archives. Gzip, Bzip2, XZ, and Zstandard inputs
are single compressed streams and are extracted to their payload file.

## Create or compress to ZIP and 7z

These are the libarchive-backed output formats currently available:

| Output | Typical conversion | Compression options |
| --- | --- | --- |
| ZIP | Files or ROMs → `.zip` | Store, deflate, or Zstandard |
| 7z | Files or ROMs → `.7z` | LZMA2 |

The browser exposes the matching codec settings when the input is compatible.
The CLI format table has the complete aliases, codec values, and command-line
options: [container and compression formats](../hosting/cli.md#container-and-compression-formats).

## Extract-only inputs

rom-weaver extracts ZIPX, RAR, TAR, TAR.GZ, TAR.BZ2, TAR.XZ, Gzip, Bzip2, XZ,
and Zstandard, but does not create those formats. Use [Apply patches](apply-rom-patches.md)
to work with an extracted file, or the CLI's `extract` command when you need
the files without applying a patch.

Specialized disc and ROM containers are intentionally outside this guide for
now.
