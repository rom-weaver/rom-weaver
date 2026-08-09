# Choosing a patch format

BPS, IPS, xdelta, PPF, and a dozen more. This guide explains what actually
separates them and which one to publish in.

<!-- START doctoc -->
## Table of contents

- [Applying a patch? Use the format you received](#applying-a-patch-use-the-format-you-received)
- [What separates patch formats?](#what-separates-patch-formats)
- [BPS](#bps)
- [IPS and IPS32](#ips-and-ips32)
- [UPS](#ups)
- [xdelta and VCDIFF](#xdelta-and-vcdiff)
- [PPF](#ppf)
- [Other supported formats](#other-supported-formats)
- [How rom-weaver picks a patch's bytes](#how-rom-weaver-picks-a-patchs-bytes)
- [Which format should I choose?](#which-format-should-i-choose)

<!-- END doctoc -->

## Applying a patch? Use the format you received

Use whatever format you were handed. rom-weaver applies 21 patch families; the
[full format table](../reference/formats.md#patch-formats) shows whether yours
is supported before you consider converting it.

Converting a patch to another format does not fix a checksum error either. The
format is not the problem; the starting file is. Go to
[Fix a checksum error](../how-to/fix-checksum-errors.md) instead.

This guide is for people publishing a patch.

## What separates patch formats?

Every format on this page records the same thing: which bytes changed. What
separates them is how much they know about the file you are supposed to start
from.

Some store a checksum of the original inside the patch. When a user feeds in
the wrong file, the patcher stops and says so. Some store nothing, so the
patcher happily applies your changes to the wrong game and hands back a broken
file that looks fine until it is not.

That difference decides most of your choice. For cartridge-sized files, size
and speed usually matter less than whether users can detect a mistake. Disc-sized
files make patch size and tool support more important.

No format records everything, though. None of them know which region you meant
or which revision, so write the region, the revision, the header state, the
patch order, and the expected checksums in your release notes regardless.

## BPS

BPS stores a checksum of the original, of the finished file, and of the patch
itself. A patcher can therefore reject the wrong starting file, and confirm
the result came out right.

That makes it a strong default for cartridge games when your audience has a
BPS-compatible patcher. rom-weaver applies and creates BPS; to publish one,
see the [browser](../how-to/create-rom-patches.md) or
[CLI](../how-to/cli-create.md) create guide.

## IPS and IPS32

IPS is one of the oldest and most widely supported patch formats. It is a plain
list of "at this offset, write these bytes." Nothing else. In particular, it
stores no checksum of the original, so an IPS patcher cannot confirm it was
handed the right starting file. rom-weaver reads the record layout for hints
(see [How rom-weaver picks a patch's bytes](#how-rom-weaver-picks-a-patchs-bytes)),
but hints are not proof.

Pick IPS when reaching old tools matters more than catching user error, and
always publish the expected checksums beside the download.

IPS also has a hard limit built into its 24-bit offsets: it cannot encode a
change that starts at or beyond 16 MiB. Create stops offering IPS when either
input reaches that boundary. IPS32 widens the offsets so larger files work.
rom-weaver applies and creates both.

## UPS

UPS stores checksums of the input and the output, so it can catch a wrong
starting file the way BPS does.

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

PPF was designed for disc patching and remains in use. Different PPF versions
can do different things, so your release notes carry more weight than usual
here.

Discs need more care than cartridges in general. A file ending in `.bin` or
`.iso` tells you almost nothing: track layout, image format, and which dump it
came from all change the bytes. Get your users onto the exact disc image you
built against before you treat a mismatch as a patcher bug.

rom-weaver applies and creates PPF.

## Other supported formats

rom-weaver also handles SOLID, GDIFF, HDiffPatch/HPatchZ, APS, APSGBA, RUP,
PAT, EBP, BDF/BSDIFF40, BSP, MOD, DLDI, DPS, and the Dreamcast-specific DCP
workflow. Support for applying and support for creating are not the same for
every one of these.

The [full format table](../reference/formats.md#patch-formats) is the authoritative list of
names, extensions, and what rom-weaver can currently apply and create.

## How rom-weaver picks a patch's bytes

Some ROM dumps carry a copier header: a small block of padding old duplicating
hardware wrote in front of the real data. A patch author either included it or
did not, and the patch has to be applied to the matching form. Applied to the
wrong one, every change lands at the wrong place. The result usually still
boots, which is what makes the mistake expensive.

A format that stores a checksum of its original settles this outright. BPS, UPS
and RUP do. rom-weaver hashes the dump both ways and takes whichever matches, so
the answer is proof, not preference.

IPS stores no such checksum, so rom-weaver reads the shape of the patch instead:

- Changes that reach past the end of the shorter form cannot have been written
  for it.
- Changes that fall inside the copier header were addressing real ROM data,
  because nobody edits copier padding.
- A change is normally trimmed so its first and last byte differ from what was
  there before. Edges that already match the bytes underneath them point at the
  wrong form.

When the shape settles nothing, rom-weaver applies the patch both ways and keeps
the version the console still recognises as its own ROM, judged by the internal
header every platform keeps. Its own checksum is a weak signal here, because a
ROM hack routinely leaves it stale.

None of this is proof, and rom-weaver treats it that way: when the evidence does
not separate the two forms it changes nothing and leaves the dump as it found
it. Publishing the expected checksums beside an IPS download is still the only
way to make the question answerable.

## Which format should I choose?

- **Applying somebody's patch:** the format they gave you, with the exact file
  they documented.
- **Publishing for a cartridge game:** BPS, for the checksums it carries.
- **Publishing where old patchers must work:** IPS, with checksums in your
  release notes.
- **Publishing for a disc or a very large file:** xdelta/VCDIFF or PPF, or
  whatever that platform's community already uses.
- **Publishing several patches at once:** any of the above, plus a rom-weaver
  bundle to record the order, the optional pieces, and the checksums.

Picked one? [Create a patch](../how-to/create-rom-patches.md) walks through making it
and, more importantly, testing it. Back to the [guide index](../README.md).
