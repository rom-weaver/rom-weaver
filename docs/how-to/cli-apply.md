# Apply patches from the CLI

Apply one patch or an ordered chain in the terminal, handle headers and byte order, verify checksums, and validate patches without keeping an output ROM. New to the CLI? Start with [your first apply](../tutorials/cli-first-weave.md). Each recipe uses only the flags its task needs; the [patching flags](../reference/cli.md#patching) are catalogued in the reference.

<!-- START doctoc -->
## Table of contents

- [Apply one or more patches](#apply-one-or-more-patches)
- [Pipe the patched ROM to another program](#pipe-the-patched-rom-to-another-program)
- [Pick one patch out of an archive](#pick-one-patch-out-of-an-archive)
- [Verify the ROM before and after](#verify-the-rom-before-and-after)
- [Apply a patch made for a headerless ROM](#apply-a-patch-made-for-a-headerless-rom)
- [Apply an N64 patch regardless of byte order](#apply-an-n64-patch-regardless-of-byte-order)
- [Validate a patch chain](#validate-a-patch-chain)
- [Where next](#where-next)

<!-- END doctoc -->

## Apply one or more patches

Apply one patch, or several in order, each on the result of the last:

```bash
rom-weaver patch apply \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc

rom-weaver patch apply \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

`patch apply` is the canonical spelling; `weave` remains accepted for compatibility.

An output extension matching the selected ROM leaf writes a plain ROM, so `translated.sfc` does not need `--no-compress`. A registered container extension such as `.zip` still compresses the result. Use `--no-compress` to force raw bytes. The [output reference](../reference/cli.md#output-and-compression) lists compression overrides and aliases.

For an ordinary file apply, omit `--output` to write a sibling such as `original-patched.sfc`. Existing names are preserved by adding a numeric suffix. Bundle applies keep their bundle-provided output name; a bundle without one still requires `--output`.

Formats that carry their own checksums are verified strictly, so a wrong starting ROM stops before anything is written - see [Fix a checksum error](fix-checksum-errors.md) when that happens.

## Pipe the patched ROM to another program

Use `--output -` and `--no-compress` to send the patched ROM to a compressor:

```bash
rom-weaver patch apply \
  --input original.sfc \
  --patch translation.bps \
  --no-compress --output - | gzip > translated.sfc.gz
```

To have rom-weaver produce the archive itself, replace `--no-compress` with `--compress-format zip` and redirect stdout to a ZIP file. The operation finishes in temporary storage before it writes stdout. See the [binary pipeline reference](../reference/cli.md#binary-pipelines) for storage requirements and restrictions.

## Pick one patch out of an archive

Point `--patch` at an archive and `--patch-select` at the file inside it:

```bash
rom-weaver patch apply \
  --input game.chd \
  --select '*.bin' \
  --patch quality-of-life.7z \
  --patch-select 'Game (USA)/Quality of Life.ppf' \
  --no-compress \
  --output patched.bin
```

`--select` chooses the payload inside the input, `--patch-select` the file inside the patch archive. Without the second flag, `--select` applies to both, and no single pattern can match a `.bin` in the input and a `.ppf` in the patch.

Match on the path when the archive nests its patches in folders: `'*USA*/*.ppf'` works, a bare `'*USA*'` does not.

Repeat `--patch-select` once per `--patch`, in order; each binds to the `--patch` before it:

```bash
rom-weaver patch apply \
  --input game.sfc \
  --patch base.zip --patch-select base-v2.bps \
  --patch extras.zip --patch-select widescreen.bps \
  --output patched.sfc
```

## Verify the ROM before and after

When a patch page publishes the expected checksums, pin them so the run fails loudly instead of producing a broken ROM:

```bash
rom-weaver patch apply \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --expect-in crc32=ABCD1234 \
  --expect-out sha1=0123456789abcdef0123456789abcdef01234567
```

`--expect-in` stops before patching unless the input matches; `--expect-out` fails the run unless the finished ROM matches.

## Apply a patch made for a headerless ROM

Headers are worked out automatically: `--patch-header auto` matches each patch to the headered or headerless form of your ROM, and `--output-header auto` keeps the header only when emulators need it. Override them when a patch author tells you to, and repair internal checksums the patch left stale:

```bash
rom-weaver patch apply \
  --input game.smc \
  --patch hack.ips \
  --output patched.sfc \
  --patch-header strip \
  --output-header strip \
  --repair-checksum
```

## Apply an N64 patch regardless of byte order

N64 ROMs circulate in three interleavings, and a patch only applies to the one it was made against. The default `--n64-byte-order auto` matches your ROM to the patch's source CRC32 and writes the output back in the order the input arrived in, so usually there is nothing to do. An IPS patch carries no checksum; auto then reads the shape of its changes, and says so in the report when that settles it. Force a specific order when auto reports nothing and the result looks wrong:

```bash
rom-weaver patch apply \
  --input game.n64 \
  --patch fix.bps \
  --output fixed.z64 \
  --n64-byte-order big-endian
```

<a id="check-patches-without-writing-anything"></a>

## Validate a patch chain

`patch validate` checks the chain without keeping an output ROM. It can create temporary files while applying the patches:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups
```

Patches default to automatic checksum inference. Pass `--default-patch-basis base` for patches made from the original ROM, or `previous` for a dependent chain.

Pass `--independent` to check each patch separately and report every verdict. Use `--expect-in ALGO=HEX` to check the ROM itself.

## Where next

- A checksum mismatch is almost always a wrong starting file; see [Fix a checksum error](fix-checksum-errors.md).
- Record a finished run as a shareable recipe with [Bundles from the CLI](cli-bundles.md).
- Bake cheat codes into a ROM (`--code`), write a bundle alongside the patched ROM (`--emit-bundle`, `--tui`), or patch straight from a `rom-weaver-bundle.json`: the [patching flags](../reference/cli.md#patching) cover every option, and `rom-weaver patch apply --help` is authoritative.
