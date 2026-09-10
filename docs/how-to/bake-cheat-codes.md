# Bake cheat codes into a ROM

Write Game Genie, GameShark/Pro Action Replay, or raw Xploder codes permanently into a ROM with `rom-weaver patch apply --code`, so the effect is there without a cheat device or an emulator cheat list. To share the same change as a patch file instead, see [Share a cheat as a patch](#share-a-cheat-as-a-patch).

<!-- START doctoc -->
## Table of contents

- [Bake one code](#bake-one-code)
- [Bake several codes](#bake-several-codes)
- [Say which console or scheme a code is for](#say-which-console-or-scheme-a-code-is-for)
- [Combine codes with a patch](#combine-codes-with-a-patch)
- [Share a cheat as a patch](#share-a-cheat-as-a-patch)
- [Use the cheat database instead of typing codes](#use-the-cheat-database-instead-of-typing-codes)
- [Build a patch from database cheats](#build-a-patch-from-database-cheats)
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

One flag also takes a list. Codes joined with `+`, commas, or newlines are split into single codes, so a saved list works as it is:

```bash
rom-weaver patch apply --input game.nes --code "$(cat codes.txt)" --output game-coded.nes
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

`--code-system` accepts `nes`, `snes`, `genesis`, `32x`, `sms`, `gamegear`, `sg1000`, `gameboy`, `gba`, and `psx`. `--code-kind` accepts `auto` (the default), `game-genie`, `gameshark`/`par`, and `xploder`.

A Master System Game Genie code works the same way:

```bash
rom-weaver patch apply \
  --input game.sms \
  --code 00A-1FA \
  --code-system sms \
  --output game-coded.sms
```

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

The codes are applied after the last patch. A patch that carries a source checksum still sees the ROM it was built for, and a code wins over a patch that changes the same byte. Code offsets are computed against the input ROM, so `--code` cannot be combined with `--patch-header strip` or `--n64-byte-order`.

## Share a cheat as a patch

`patch create` accepts the same `--code`, `--code-system`, and `--code-kind` flags in place of `--modified`. The result is an ordinary patch that holds only the cheat's byte writes, so it can be shared without the ROM and applied by any patcher:

```bash
rom-weaver patch create \
  --original game.nes \
  --code SXIOPO \
  --output infinite-lives.ips
```

The format follows the output extension, or `--format`. Applying the patch to the clean ROM gives the same bytes as baking the code directly.

An extended SOLID header records the codes in its comment when you do not write one, so the patch says what it does:

```bash
rom-weaver patch create \
  --original game.nes \
  --code SXIOPO \
  --solid-game "Example Game" \
  --solid-hack "Infinite lives" \
  --solid-extended \
  --output infinite-lives.solid
```

## Use the cheat database instead of typing codes

Install the shards once:

```bash
rom-weaver setup
```

That puts them in `cheats` beside the identify packs, which is where every cheat flag looks by default. `--cheat-database DIR` and `$ROM_WEAVER_CHEAT_DATABASE` point somewhere else.

See what the database has for a ROM:

```bash
rom-weaver cheat list --input game.nes
```

Each row is an ID, a delivery, the raw code, and a description. A `rom` entry can be baked into the ROM; an `unsupported` entry cannot, and the row says why.

Bake the entries you want:

```bash
rom-weaver patch apply \
  --input game.nes \
  --cheat "Infinite lives" \
  --cheat cheat_5a8473f0d9d3ed2c6f75737d \
  --output game-coded.nes
```

Select by ID when a description names more than one entry; the run fails rather than guessing. Selecting an `unsupported` entry fails and names it.

Two `rom` cheats that write different values to the same byte fail with `cheat_write_conflict`. Add `--allow-cheat-conflicts` to let the last one win.

## Build a patch from database cheats

```bash
rom-weaver patch create --original game.nes --cheat "Infinite lives" --output cheats.ips
```

Only `rom` entries can go in a patch. Without `--cheat` every cheat the matched game holds is used. The report names the entries it skipped in `details.skipped_cheats`.

## Prove what you produced

Hash the result so you can tell the baked ROM apart from the clean one later:

```bash
rom-weaver checksum --input game-coded.nes --algo sha256
```

Keep the clean ROM. A patch author's checksum refers to the unbaked file, so a later patch will refuse the baked one.

## Related

- [CLI reference](../reference/cli.md#cheats): the `cheat` command and the shared cheat flags.
- [CLI reference](../reference/cli.md#extras): `--code` beside the other patching extras.
- [Create patches from the CLI](cli-create.md): the rest of the create workflow.
- [Cheat database reference](../reference/cheat-database.md): the directory layout, delivery classes, and match classes.
- [Apply patches from the CLI](cli-apply.md): the rest of the apply workflow.
- [How patching works](../explanation/how-patching-works.md): why the exact starting bytes matter.
