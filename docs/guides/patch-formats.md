# Choose a ROM patch format

rom-weaver applies 21 patch families and creates most of them. When applying a
release, use the format its author provides. When publishing a new patch,
choose based on source validation, file size, and the tools your audience uses.

<!-- START doctoc -->
## Table of contents

- [Start with the release instructions](#start-with-the-release-instructions)
- [BPS](#bps)
- [IPS and IPS32](#ips-and-ips32)
- [UPS](#ups)
- [xdelta and VCDIFF](#xdelta-and-vcdiff)
- [PPF](#ppf)
- [Other supported formats](#other-supported-formats)
- [A practical choice](#a-practical-choice)

<!-- END doctoc -->

## Start with the release instructions

A patch format cannot identify every requirement by itself. The author should
still document the game region, revision, copier-header state or disc layout,
source checksum, patch order, and expected output checksum.

Converting an existing patch rarely fixes a source mismatch. Find the correct
base file before changing formats.

## BPS

BPS is a strong default for many modern cartridge-ROM projects. It stores CRC32
values for the source, target, and patch, so rom-weaver can reject the wrong
source and verify the finished output.

Choose BPS when embedded validation matters and your audience uses current
patchers. rom-weaver can apply and create BPS patches in the browser and CLI.

```bash
rom-weaver patch create \
  --original original.sfc \
  --modified modified.sfc \
  --output release.bps
```

## IPS and IPS32

IPS is simple, old, and widely supported. It describes changes at byte offsets,
which makes it useful for legacy workflows but leaves source identification to
the release notes. Classic IPS does not embed a checksum for the required base
ROM.

The original IPS offset design is unsuitable for files at or beyond 16 MiB.
IPS32 expands the address range for larger files.

Use IPS when compatibility with established tools is more important than
embedded source validation. Always publish the expected source checksum beside
it. rom-weaver can apply and create both IPS and IPS32.

## UPS

UPS carries input and output CRC32 values and is established in ROM-patching
workflows. Those values help distinguish the wrong base file from a damaged
patch or unexpected result.

Use UPS when the project's existing tools or community expect it. rom-weaver
can apply and create UPS patches.

## xdelta and VCDIFF

VCDIFF is a general delta-encoding format; xdelta is a widely used
implementation and ecosystem around it. ROM-hack projects often use xdelta for
larger binaries and disc images. Common extensions include `.xdelta`, `.delta`,
`.dat`, and `.vcdiff`.

Do not assume every xdelta patch identifies its source for you. Keep the
release's checksum and command instructions. rom-weaver can apply and create
xdelta/VCDIFF patches.

## PPF

PPF is associated with disc-image patching, especially CD-era projects.
Different PPF versions provide different capabilities, so the release
instructions remain important.

A disc image is more than a filename ending in `.bin` or `.iso`. Track layout,
image format, and the exact dump may all matter. Prepare the form named by the
author before treating a checksum mismatch as a patcher failure.

rom-weaver can apply and create PPF patches.

## Other supported formats

rom-weaver also handles SOLID, GDIFF, HDiffPatch/HPatchZ, APS, APSGBA, RUP, PAT,
EBP, BDF/BSDIFF40, BSP, MOD, DLDI, DPS, and the specialized Dreamcast DCP
workflow. Apply and create support varies by format.

The [complete patch format table](../cli.md#patch-formats) is the source of
truth for aliases, extensions, and current apply/create support.

## A practical choice

- **Applying an existing patch:** use the supplied format and exact documented
  base file.
- **Publishing a modern cartridge-ROM patch:** consider BPS for its embedded
  source and output checks.
- **Supporting older patchers:** offer IPS and publish separate checksums.
- **Working with larger files or disc images:** consider xdelta/VCDIFF, PPF, or
  the format already established by that platform's community.
- **Publishing a patch chain:** use a rom-weaver bundle to record order,
  optional selections, checksums, and output naming.

After choosing a format, follow the [creation guide](create-rom-patches.md) and
test the generated artifact against a fresh copy of the original.
