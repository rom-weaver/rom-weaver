# Pick a patch format

BPS, IPS, xdelta, PPF, and a dozen more. This guide explains what actually
separates them and which one to publish in.

<!-- START doctoc -->
## Table of contents

- [Applying a patch? Skip this guide](#applying-a-patch-skip-this-guide)
- [The one thing that separates them](#the-one-thing-that-separates-them)
- [BPS](#bps)
- [IPS and IPS32](#ips-and-ips32)
- [UPS](#ups)
- [xdelta and VCDIFF](#xdelta-and-vcdiff)
- [PPF](#ppf)
- [Everything else](#everything-else)
- [Just tell me which one](#just-tell-me-which-one)

<!-- END doctoc -->

## Applying a patch? Skip this guide

Use whatever format you were handed. rom-weaver applies 21 families of patch,
so it is very unlikely you need to do anything about the format at all.

Converting a patch to another format does not fix a checksum error either. The
format is not the problem; the starting file is. Go to
[Fix a checksum error](fix-checksum-errors.md) instead.

This guide is for people publishing a patch.

## The one thing that separates them

Every format on this page records the same thing: which bytes changed. What
separates them is how much they know about the file you are supposed to start
from.

Some store a checksum of the original inside the patch. When a user feeds in
the wrong file, the patcher stops and says so. Some store nothing, so the
patcher happily applies your changes to the wrong game and hands back a broken
file that looks fine until it is not.

That difference decides most of your choice. Size and speed barely matter at
these file sizes. Whether your users can find out they made a mistake matters
a lot.

No format records everything, though. None of them know which region you meant
or which revision, so write the region, the revision, the header state, the
patch order, and the expected checksums in your release notes regardless.

## BPS

BPS stores a checksum of the original, of the finished file, and of the patch
itself. A patcher can therefore reject the wrong starting file, and confirm
the result came out right.

That makes it a strong default for cartridge games, as long as your audience
uses a patcher from this century. rom-weaver applies and creates BPS in both
the browser and the terminal.

```bash
rom-weaver patch create \
  --original original.sfc \
  --modified modified.sfc \
  --output release.bps
```

## IPS and IPS32

IPS is ancient and universally supported. It is a plain list of "at this
offset, write these bytes". Nothing else. In particular, no checksum of the
original, so an IPS patcher cannot tell a correct starting file from a wrong
one.

Pick IPS when reaching old tools matters more than catching user error, and
always publish the expected checksums beside the download.

IPS also has a hard size limit built into how it stores offsets: it cannot
address files at or beyond 16 MiB. IPS32 widens the offsets so larger files
work. rom-weaver applies and creates both.

## UPS

UPS stores checksums of the input and the output, so it can catch a wrong
starting file the way BPS does. It is well established in ROM patching and
some communities standardized on it years ago.

Pick UPS when the tools or the community you are publishing into expect it.
rom-weaver applies and creates it.

## xdelta and VCDIFF

VCDIFF is a general-purpose format for describing the difference between any
two files. xdelta is the widely used tool built around it, and its name is
what most people say.

It handles large binaries and disc images well, which is why disc projects
reach for it. Patches turn up as `.xdelta`, `.delta`, `.dat`, and `.vcdiff`.

Do not assume an xdelta patch identifies its source for you; that depends on
how it was made. Publish the checksums and the exact command you expect users
to run. rom-weaver applies and creates xdelta and VCDIFF.

## PPF

PPF has been the disc patching format since the CD era, and plenty of projects
still ship it. Different PPF versions can do different things, so your release
notes carry more weight than usual here.

Discs need more care than cartridges in general. A file ending in `.bin` or
`.iso` tells you almost nothing: track layout, image format, and which dump it
came from all change the bytes. Get your users onto the exact disc image you
built against before you treat a mismatch as a patcher bug.

rom-weaver applies and creates PPF.

## Everything else

rom-weaver also handles SOLID, GDIFF, HDiffPatch/HPatchZ, APS, APSGBA, RUP,
PAT, EBP, BDF/BSDIFF40, BSP, MOD, DLDI, DPS, and the Dreamcast-specific DCP
workflow. Support for applying and support for creating are not the same for
every one of these.

The [full format table](../hosting/cli.md#patch-formats) is the authoritative list of
names, extensions, and what rom-weaver can currently apply and create.

## Just tell me which one

- **Applying somebody's patch:** the format they gave you, with the exact file
  they documented.
- **Publishing for a cartridge game:** BPS, for the checksums it carries.
- **Publishing where old patchers must work:** IPS, with checksums in your
  release notes.
- **Publishing for a disc or a very large file:** xdelta/VCDIFF or PPF, or
  whatever that platform's community already uses.
- **Publishing several patches at once:** any of the above, plus a rom-weaver
  bundle to record the order, the optional pieces, and the checksums.

Picked one? [Create a patch](create-rom-patches.md) walks through making it
and, more importantly, testing it. Back to the [guide index](README.md).
