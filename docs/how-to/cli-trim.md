# Trim a ROM from the CLI

Cut the padding off a ROM with `rom-weaver trim`, check the saving before you commit to it, and pad a trimmed file back out again.

<!-- START doctoc -->
## Table of contents

- [See what would change](#see-what-would-change)
- [Write a trimmed copy](#write-a-trimmed-copy)
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

`--extension` names the copy from the input instead:

```bash
rom-weaver trim --input game.nds --extension trimmed.nds
```

For a GameCube or Wii disc, keep the default `.rvz` output name: this path converts the disc losslessly to RVZ without removing unused sectors. It requires a separate output and does not support restore markers.

`--in-place` rewrites the source file. Use it instead of pointing `--output` at a symlink or hard link to the input; output aliases are rejected even with `--force`. Keep a known-good copy first; a trimmed ROM is not always the file a patch expects.

## Make the trim reversible

For NDS-family, GBA, and 3DS ROMs, write a separate copy with `--revert-marker` to record the original length and padding byte. XISO and RVZ conversion reject this option because rebuilding the disc cannot be reversed from a padding footer:

```bash
rom-weaver trim --input game.gba --output game-trimmed.gba --revert-marker
```

The footer stores one repeated byte, not a copy of the removed data. Exact restoration requires uniform removed padding. Keep the source when trimming NDS files whose removed area may contain other bytes. The fill byte is recorded before trimming, including with `--in-place`.

## Put the padding back

```bash
rom-weaver trim --input game-trimmed.gba --output game.gba --revert
```

`--revert` works for NDS, GBA, and 3DS. XISO trimming and RVZ conversion do not support this operation. Without a footer from `--revert-marker`, the restored padding is reconstructed and may not be byte-identical.

## Trim files inside an archive

`trim` opens archives for you and filters to ROMs by default:

```bash
rom-weaver trim --input games.zip
```

Each supported ROM is written beside the archive using its member filename and the trim extension. `--output` requires exactly one supported ROM. Conflicting output names are rejected before writing, including with `--force`.

`--no-filter` considers every member instead. A patch-only `--filter` is rejected.

## Look up what is supported

[Trim support](../reference/formats.md#trim-support) lists every trim target and every flag alias. For whether to trim at all, see [Choosing a compression format](../explanation/compression-formats.md).
