# Apply patches from the CLI

Apply one patch or an ordered chain in the terminal, control headers, byte
order, and checksum verification, and validate patches without writing
anything. New to the CLI? Start with [Get started](get-started.md).

<!-- START doctoc -->
## Table of contents

- [Apply one or more patches](#apply-one-or-more-patches)
- [Patch apply behavior](#patch-apply-behavior)
- [Patch validation](#patch-validation)
- [Where next](#where-next)

<!-- END doctoc -->

## Apply one or more patches

Apply one patch, or several in order:

```bash
rom-weaver weave \
  --input original.sfc \
  --patch translation.bps \
  --output translated.sfc \
  --no-compress

rom-weaver weave \
  --input original.sfc \
  --patch base.ips \
  --patch fixes.ups \
  --output patched.zip
```

`weave` is the short name for `patch apply`; either spelling works.

The result is compressed by default, into whatever the `--output` extension
names. Pass `--no-compress` for a plain ROM, or set `--compress-format`,
`--compress-codec`, and `--compress-level` yourself.

## Patch apply behavior


Repeat `--patch` to run several patches in order, each on the result of the
last. Leave `--patch` out entirely and rom-weaver looks for RetroArch-style
patches sitting next to the ROM inside the input archive. A
`rom-weaver-bundle.json` can supply the ROM, the patch order, the checks, and
the output name instead.

Checking the result:

- Formats that carry their own checksums are verified strictly.
  `--ignore-checksum-validation` applies the patch anyway, which can produce a
  broken ROM.
- `--expect-in ALGO=HEX` stops unless the ROM about to be patched matches.
- `--expect-out ALGO=HEX` fails unless the finished ROM matches.
- `--assume-in ALGO=HEX` takes a checksum on trust rather than reading the ROM
  to compute it. It is a speed option for scripts and verifies nothing.

Headers and byte order:

- `--patch-header auto|keep|strip` decides whether each patch applies to the
  ROM with or without its copier header. Auto works it out per patch from the
  patch's own source checksum.
- `--output-header auto|keep|strip` decides whether the finished ROM keeps its
  header. Auto keeps the ones emulators need and drops the ones they do not.
- `--repair-checksum` repairs supported internal checksums and compatibility
  header fields after patching.
- `--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` puts an
  N64 ROM in the interleaving a patch expects. Auto matches the patch's source
  CRC32, and the output is written back in the order the input arrived in.

Extras:

- `--code` bakes Game Genie or GameShark/Pro Action Replay codes into the ROM,
  as if they were a patch.
- `--emit-bundle PATH` also writes a `rom-weaver-bundle.json` recording the run:
  the ROM's checksums, the patches in order, and the result. It runs the same
  code as `bundle create`, so the file is byte-identical to the equivalent
  `bundle create` call. It carries no per-patch names or authors; for those use
  `bundle create`, `bundle create --from`, or `--tui`.
- `--tui` asks for each patch's name, version, author, and optional state plus
  an output name, then applies and writes the bundle. It needs a terminal, and
  for now it needs explicit `--patch` files; re-opening a bundle is not
  supported yet.

DCP patches need a Dreamcast `.cue` or `.gdi` input. They rebuild the GD-ROM
data track and reassemble the whole disc, so they cannot be chained with
another patch or combined with the header and checksum options.

## Patch validation


`patch validate` runs the same checks as `patch apply` but writes nothing: it
parses each patch and verifies every checksum the format carries.

`--expect-in` adds a check on the ROM itself, and accepts a checksum
(`ALGO=HEX`), an exact size (`size=N`), or a minimum size (`min-size=N`).
`--strip-header` and `--n64-byte-order` put the ROM in the form the patches
expect before checking; N64 byte order defaults to matching the patch's source
CRC32.

Patches are checked as a chain by default, each against the output of the one
before it. `--independent` checks each one against the original ROM instead and
reports a verdict per patch, rather than stopping at the first failure.

## Where next

- A checksum mismatch is almost always a wrong starting file; see
  [Fix a checksum error](../usage/fix-checksum-errors.md).
- Record a finished run as a shareable recipe with
  [Bundles from the CLI](bundles.md).
- Run `rom-weaver patch apply --help` or `rom-weaver patch validate --help`
  for every flag; the [CLI reference](reference.md) covers their shared
  behavior.
