# Fix ROM patch checksum errors

A checksum mismatch means the patch received different bytes from the ones its
author expected. The filename may look right while the region, revision, header
state, byte order, archive entry, or earlier patch is wrong.

<!-- START doctoc -->
## Table of contents

- [What a checksum tells you](#what-a-checksum-tells-you)
- [Diagnose the mismatch in order](#diagnose-the-mismatch-in-order)
- [Common causes](#common-causes)
  - [Wrong region or revision](#wrong-region-or-revision)
  - [Copier header present or absent](#copier-header-present-or-absent)
  - [Nintendo 64 byte order](#nintendo-64-byte-order)
  - [Incorrect patch order](#incorrect-patch-order)
- [Avoid forcing a bad source](#avoid-forcing-a-bad-source)

<!-- END doctoc -->

## What a checksum tells you

A checksum is a compact fingerprint calculated from a file's bytes. If your
value differs from the release's expected value, at least one byte differs.
Renaming the file does not change its checksum.

BPS and UPS patches carry source and output checksums. Other releases may list
CRC32, MD5, SHA-1, or SHA-256 values in their notes. Compare values made with
the same algorithm.

In the webapp, review the checksums shown after selecting a ROM. In the CLI,
calculate one directly:

```bash
rom-weaver checksum --input game.sfc --algo sha256
```

rom-weaver supports CRC32, MD5, SHA-1, SHA-256, BLAKE3, CRC32C, CRC16, and
Adler-32.

## Diagnose the mismatch in order

1. Re-read the release instructions and record the exact region, revision,
   header state, disc layout, patch order, and checksum.
2. Return to a clean source that has not already been translated, trained,
   trimmed, or patched.
3. Calculate the checksum with the algorithm named by the release.
4. Confirm that the selected file inside an archive is the intended ROM.
5. Review copier-header detection and Nintendo 64 byte order.
6. If several patches are involved, confirm which patch targets the clean
   source and which targets an earlier patched result.
7. Retry only after identifying the difference.

This order narrows the problem without changing several variables at once.

## Common causes

### Wrong region or revision

USA, Japan, Europe, and other releases often have different code and data
layouts. Rev 0, Rev 1, reprints, and bug-fix releases can behave identically in
an emulator while differing at the byte offsets a patch changes.

Use the exact release named by the patch author. A matching title screen is not
evidence of a byte-for-byte match.

### Copier header present or absent

Some cartridge dumps contain an extra copier header, commonly 512 bytes. A
patch may expect the headered or unheadered form.

rom-weaver tests checksum variants and can automatically choose a compatible
header state when the patch provides enough source information. In the CLI,
`--patch-header auto|keep|strip` controls the bytes presented to each patch, and
`--output-header auto|keep|strip` controls the finished file.

Do not strip a header blindly. First compare the raw and headerless checksums
with the release notes.

### Nintendo 64 byte order

Nintendo 64 dumps commonly use big-endian, little-endian, or byte-swapped
layouts. They can represent the same game data while producing different raw
checksums.

The CLI option
`--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped` controls the
form supplied to the patch. `auto` can match a patch's source CRC32 and writes
the result back in the input's original order.

### Incorrect patch order

In a multi-patch release, a later patch may target the output of an earlier
patch rather than the clean ROM. Repeat `--patch` in the documented order or
arrange the cards in that order in the webapp.

Validate a chain without writing an output:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch base.bps \
  --patch fixes.ips
```

By default, each patch is checked against the output of the one before it.

## Avoid forcing a bad source

`--ignore-checksum-validation` exists for expert recovery and research
workflows, but it does not make mismatched bytes correct. A forced patch can
produce an output file successfully and still fail during startup or later
gameplay.

If the expected source cannot be identified, stop and ask the patch author or
project community for the precise checksum and revision. Do not download
copyrighted ROMs from an untrusted site to make the warning disappear.

Once the source matches, follow the
[apply guide](apply-rom-patches.md) and keep the verified original unchanged for
future releases.
