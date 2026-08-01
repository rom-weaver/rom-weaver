# Extract, convert, and compress archive formats

rom-weaver can open common archives and single compressed files, then create
ZIP or 7z outputs. Everything runs locally in the browser or through the CLI;
files are not uploaded.

<!-- START doctoc -->
## Table of contents

- [Choose an operation](#choose-an-operation)
- [Formats you can open](#formats-you-can-open)
- [Formats you can create](#formats-you-can-create)
- [Formats you can only open](#formats-you-can-only-open)

<!-- END doctoc -->

## Choose an operation

Use [Apply](https://rom-weaver.com/apply) in the browser to open a supported
archive while applying patches, or choose ZIP or 7z as the compressed output.
The [CLI](../cli/reference.md) exposes the same archive handlers directly:

```sh
rom-weaver extract --input patches.7z --output extracted-patches
rom-weaver compress --input extracted-patches --output patches.zip
```

Those two commands move the 7z contents into a ZIP: first extract them to a
directory, then compress that directory. The new ZIP includes
`extracted-patches/` as its top-level directory because `compress` archives the
paths you supply. It does not unpack an archive input by itself; if you pass
`patches.7z` directly, the new archive contains the `patches.7z` file.

## Formats you can open

These formats can be opened and extracted:

| Format | Extensions | Open/extract | Create |
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

## Formats you can create

rom-weaver can create these two general-purpose archive formats:

| Format | Output extension | Compression options |
| --- | --- | --- |
| ZIP | `.zip` | Store, deflate, or Zstandard |
| 7z | `.7z` | LZMA2 |

The browser exposes the matching codec settings when the input is compatible.
The CLI format table has the complete aliases, codec values, and command-line
options: [container and compression formats](../reference/formats.md#container-and-compression-formats).

## Formats you can only open

rom-weaver can open ZIPX, RAR, TAR, TAR.GZ, TAR.BZ2, TAR.XZ, Gzip, Bzip2, XZ,
and Zstandard, but cannot create them. Use [Apply patches](apply-rom-patches.md)
to work with a file inside one of these formats, or the CLI's `extract` command
when you need the files without applying a patch.

Specialized disc and ROM containers are intentionally outside this guide for
now. Their capabilities are listed in the
[CLI format table](../reference/formats.md#container-and-compression-formats).
