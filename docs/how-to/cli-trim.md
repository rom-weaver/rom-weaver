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

`--in-place` rewrites the source file. Keep a known-good copy first; a trimmed ROM is not always the file a patch expects.

## Make the trim reversible

Write a separate copy with `--revert-marker` to record the original length and padding byte:

```bash
rom-weaver trim --input game.gba --output game-trimmed.gba --revert-marker
```

The footer stores one repeated byte, not a copy of the removed data. Exact restoration requires uniform removed padding. Keep the source when trimming NDS files whose removed area may contain other bytes. Do not combine this option with `--in-place` when exact restoration matters: in-place trimming can record the wrong padding byte.

## Put the padding back

```bash
rom-weaver trim --input game-trimmed.gba --output game.gba --revert
```

`--revert` works for NDS, GBA, and 3DS. XISO and RVZ scrub cannot be reverted. Without a footer from `--revert-marker`, the restored padding is reconstructed and may not be byte-identical.

## Trim files inside an archive

`trim` opens archives for you and filters to ROMs by default:

```bash
rom-weaver trim --input games.zip --select 'game*.nds' --output game-trimmed.nds
```

`--no-filter` considers every member instead.

## Look up what is supported

[Trim support](../reference/formats.md#trim-support) lists every trim target and every flag alias. For whether to trim at all, see [Choosing a compression format](../explanation/compression-formats.md).
