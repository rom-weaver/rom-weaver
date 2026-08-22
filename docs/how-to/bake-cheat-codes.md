# Bake cheat codes into a ROM

Write Game Genie, GameShark/Pro Action Replay, or raw Xploder codes permanently into a ROM with `rom-weaver patch apply --code`, so the effect is there without a cheat device or an emulator cheat list.

<!-- START doctoc -->
## Table of contents

- [Bake one code](#bake-one-code)
- [Bake several codes](#bake-several-codes)
- [Say which console or scheme a code is for](#say-which-console-or-scheme-a-code-is-for)
- [Combine codes with a patch](#combine-codes-with-a-patch)
- [Prove what you produced](#prove-what-you-produced)
- [Related](#related)

<!-- END doctoc -->

## Bake one code

```bash
rom-weaver patch apply --input game.nes --code SXIOPO --output game-coded.nes
```

`--code` is treated as a patch: the codes are applied to the ROM and the result is written to `--output`. Your input file is not changed.

## Bake several codes

Repeat the flag:

```bash
rom-weaver patch apply \
  --input game.nes \
  --code SXIOPO \
  --code AEKPTZ \
  --output game-coded.nes
```

## Say which console or scheme a code is for

rom-weaver works both out from the ROM header and the code's shape. Pin them when it cannot:

```bash
rom-weaver patch apply \
  --input game.bin \
  --code 00A2-01F5 \
  --code-system genesis \
  --code-kind game-genie \
  --output game-coded.bin
```

`--code-system` accepts `nes`, `snes`, `genesis`, `gameboy`, `gba`, and `psx`. `--code-kind` accepts `auto` (the default), `game-genie`, `gameshark`/`par`, and `xploder`.

Use `gba` with `--code-kind xploder` for raw Xploder Advance codes. The tool cannot bake GBA RAM writes into a ROM. GBA ROM-patch codes use four words, for example:

```text
00000000 18000004 0000ABCD 00000000
```

Use `psx` with `--code-kind xploder` for plain PlayStation constant writes. The input must be a PS-X EXE. The tool maps writes in the loaded executable to file offsets. Encrypted and conditional codes stay runtime-only.

## Combine codes with a patch

`--code` works alongside `--patch`, so a hack and a code can land in one run:

```bash
rom-weaver patch apply \
  --input game.nes \
  --patch translation.bps \
  --code SXIOPO \
  --output game-final.nes
```

## Prove what you produced

Hash the result so you can tell the baked ROM apart from the clean one later:

```bash
rom-weaver checksum --input game-coded.nes --algo sha256
```

Keep the clean ROM. A patch author's checksum refers to the unbaked file, so a later patch will refuse the baked one.

## Related

- [CLI reference](../reference/cli.md#extras): `--code` beside the other patching extras.
- [Apply patches from the CLI](cli-apply.md): the rest of the apply workflow.
- [How patching works](../explanation/how-patching-works.md): why the exact starting bytes matter.
