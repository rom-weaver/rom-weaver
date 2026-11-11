# Trim a ROM from the CLI

Cut the padding off a ROM with `rom-weaver trim`, check the saving before you commit to it, and pad a trimmed file back out again.

<!-- START doctoc -->
## Table of contents

- [See what would change](#see-what-would-change)
- [Write a trimmed copy](#write-a-trimmed-copy)
- [Choose the output format](#choose-the-output-format)
- [Make the trim reversible](#make-the-trim-reversible)
- [Put the padding back](#put-the-padding-back)
- [Trim files inside an archive](#trim-files-inside-an-archive)
- [Look up what is supported](#look-up-what-is-supported)

<!-- END doctoc -->

## See what would change

`-n`/`--dry-run` reports the planned size change without writing a trimmed output:

```bash
rom-weaver trim --input game.nds --dry-run
```

## Write a trimmed copy

```bash
rom-weaver trim --input game.nds --output game-trimmed.nds
```

`--extension` names the copy from the input instead. It cannot be combined with `--output` or `--in-place`:

```bash
rom-weaver trim --input game.nds --extension trimmed.nds
```

`trim` does not accept GameCube or Wii discs. They are detected by content in any supported disc container (`.iso`, `.gcm`, `.rvz`, `.wbfs`, `.wia`, `.gcz`, `.ciso`, `.tgc`, `.nfs`), whatever the extension. A lone disc, or a lone archive that holds only discs, stops with an error that names the input and points to `compress`; convert the disc to RVZ with `rom-weaver compress --input game.iso --output game.rvz`. In a folder or multi-file run, discs (including discs inside archives) are skipped, counted as unsupported and in `skipped_gamecube_wii`, and the run notes that `rom-weaver compress` writes RVZ. Other non-XISO `.iso` files, such as PS2 images, are skipped as unsupported. A lone file or archive with nothing trim can use fails with exit code `1` and writes nothing; the [exit codes](../reference/cli.md#exit-codes) list the error codes.

## Choose the output format

`--output` (and `--extension`) follow the output name's extension, as `compress` and `patch apply` do. A container extension packs the trimmed file inside it; a name that matches no container writes the trimmed file itself.

| Input | Output name | Result |
| --- | --- | --- |
| Any trimmable ROM or XISO disc | `.zip`, `.7z` | The trimmed file inside the archive. |
| XISO disc | `.chd` | Rejected: an Xbox XISO cannot be stored as CHD. Use `.zip`, `.7z`, or `.xiso`. |
| 3DS ROM | `.z3ds` | The trimmed ROM packed as Z3DS. `.z3ds` always works; `.zcci` is also accepted for a cartridge image (NCSD) and `.zcxi` for an NCCH image, the name `extract` reads back as `.cci` or `.cxi`. The other Z3DS names (`.zcia`, `.z3dsx`, and the descriptor that does not match the file's payload) are an error. |
| XISO disc | `.xiso`, `.xiso.iso` | The rebuilt XISO, written as the output. |
| NDS, GBA, 3DS ROM or XISO | any extension that is not a container (such as `.nds` or `.iso`) | The trimmed file itself, as before. |
| Anything | another container (`.chd` for a cartridge ROM, `.rvz` for an NDS ROM, `.tar.gz`, and so on) | An error; nothing is written. |

The file inside an archive carries the output name without the archive extension, ending in the trimmed file's own extension: `--output game.zip` for `game.nds` holds `game.nds`, and `--output game.nds.zip` holds `game.nds`. An existing output is kept unless you pass `--force`, and a failed pack leaves it as it was. `--dry-run` applies the same rules and reports the container as the file it would write.

`--in-place` rewrites the source file. Use it instead of pointing `--output` at a symlink or hard link to the input; output aliases are rejected even with `--force`. Keep a known-good copy first; a trimmed ROM is not always the file a patch expects.

A successful trim prints nothing on stdout. With `--output`, a terminal also shows a `wrote PATH` line on stderr. Add `-v` to list each file it wrote. Warnings and errors always print.

## Make the trim reversible

For NDS-family, GBA, and 3DS ROMs, write a separate copy with `--revert-marker` to record the original length and padding byte. XISO rejects this option because rebuilding the disc cannot be reversed from a padding footer:

```bash
rom-weaver trim --input game.gba --output game-trimmed.gba --revert-marker
```

`--revert-marker` applies only when trimming; combining it with `--revert` is an error. The footer stores one repeated byte, not a copy of the removed data. Exact restoration requires uniform removed padding. Keep the source when trimming NDS files whose removed area may contain other bytes. The fill byte is recorded before trimming, including with `--in-place`.

## Put the padding back

```bash
rom-weaver trim --input game-trimmed.gba --output game.gba --revert
```

`--revert` works for NDS, GBA, and 3DS. XISO trimming does not support this operation. Without a footer from `--revert-marker`, the restored padding is reconstructed and may not be byte-identical.

## Trim files inside an archive

`trim` opens archives for you and filters to ROMs by default:

```bash
rom-weaver trim --input games.zip
```

`trim` reads the archive's file list first and extracts only the members it can use: trimmable ROMs, `.iso` files that may be XISO discs, and nested archives (including CHD and CSO, which can hold an XISO). GameCube/Wii discs are skipped without extraction when their name gives them away (`.rvz`, `.wbfs`, `.wia`, `.gcz`, `.gcm`, `.tgc`), or by reading the first bytes of an `.iso` or `.ciso` member, which works in ZIP, 7z, RAR, tar, and single-file streams such as `.iso.gz`.

Nested ZIP and tar archives can be inspected without extracting them. This includes compressed tar archives such as `.tar.gz`. Trim skips them when they hold only discs or files it cannot use.

Duplicate member names or unverified ZIP listings fall back to extraction. ZIP64 and ZIP directories exceeding the 1 MiB inspection window also use this fallback. Other nested archives, such as 7z, are extracted first. The discs inside them are still skipped.

Each supported ROM is written beside the archive using its member filename and the trim extension. `--output` requires exactly one supported ROM. Conflicting output names are rejected before writing, including with `--force`.

`--no-filter` also extracts members with names that say nothing about their contents, such as `bundle.dat`, so their contents decide; known GameCube/Wii discs are still skipped. A patch-only `--filter` is rejected.

## Look up what is supported

[Trim support](../reference/formats.md#trim-support) lists every trim target and every flag alias. For whether to trim at all, see [Choosing a compression format](../explanation/compression-formats.md).
