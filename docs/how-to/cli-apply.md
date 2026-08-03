# Apply patches from the CLI

Apply one patch or an ordered chain in the terminal, handle headers and byte
order, verify checksums, and validate patches without writing anything. New to
the CLI? Start with [your first apply](../tutorials/cli-first-weave.md). Each
recipe uses only the flags its task needs; the
[patching flags](../reference/cli.md#patching) are catalogued in the reference.

<!-- START doctoc -->
## Table of contents

- [Apply one or more patches](#apply-one-or-more-patches)
- [Verify the ROM before and after](#verify-the-rom-before-and-after)
- [Apply a patch made for a headerless ROM](#apply-a-patch-made-for-a-headerless-rom)
- [Apply an N64 patch regardless of byte order](#apply-an-n64-patch-regardless-of-byte-order)
- [Check patches without writing anything](#check-patches-without-writing-anything)
- [Where next](#where-next)

<!-- END doctoc -->

## Apply one or more patches

Apply one patch, or several in order, each on the result of the last:

```bash
rom-weaver patch apply \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --no-compress

rom-weaver patch apply \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

`patch apply` is the canonical spelling; `weave` remains accepted for compatibility.

The result is compressed by default, into whatever the `--output` extension
names. Pass `--no-compress` for a plain ROM, or set `--compress-format`,
`--compress-codec`, and `--compress-level` yourself.

Formats that carry their own checksums are verified strictly, so a wrong
starting ROM stops before anything is written - see
[Fix a checksum error](fix-checksum-errors.md) when that happens.

## Verify the ROM before and after

When a patch page publishes the expected checksums, pin them so the run fails
loudly instead of producing a broken ROM:

```bash
rom-weaver patch apply \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --expect-in crc32=ABCD1234 \
  --expect-out sha1=0123456789abcdef0123456789abcdef01234567
```

`--expect-in` stops before patching unless the input matches; `--expect-out`
fails the run unless the finished ROM matches.

## Apply a patch made for a headerless ROM

Headers are worked out automatically: `--patch-header auto` matches each patch
to the headered or headerless form of your ROM using the patch's own source
checksum, and `--output-header auto` keeps the header only when emulators need
it. Override them when a patch author tells you to, and repair internal
checksums the patch left stale:

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

N64 ROMs circulate in three interleavings, and a patch only applies to the one
it was made against. The default `--n64-byte-order auto` matches your ROM to
the patch's source CRC32 and writes the output back in the order the input
arrived in, so usually there is nothing to do. Force a specific order only
when auto has nothing to match against:

```bash
rom-weaver patch apply \
  --input game.n64 \
  --patch fix.bps \
  --output fixed.z64 \
  --n64-byte-order big-endian
```

## Check patches without writing anything

`patch validate` parses each patch and verifies every checksum the format
carries, without producing a ROM:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups
```

Patches are checked as a chain by default. Pass `--independent` to check each
one against the original ROM and get a verdict per patch, and
`--expect-in ALGO=HEX` to check the ROM itself at the same time.

## Where next

- A checksum mismatch is almost always a wrong starting file; see
  [Fix a checksum error](fix-checksum-errors.md).
- Record a finished run as a shareable recipe with
  [Bundles from the CLI](cli-bundles.md).
- Bake cheat codes into a ROM (`--code`), write a bundle alongside the patched
  ROM (`--emit-bundle`, `--tui`), or patch straight from a
  `rom-weaver-bundle.json`: the [patching flags](../reference/cli.md#patching)
  cover every option, and `rom-weaver patch apply --help` is authoritative.
