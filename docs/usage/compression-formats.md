# Pick a compression format

CHD, RVZ, Z3DS, 7z, ZIP. This guide explains which compressed format fits
which console, when trimming beats compressing, and what compression does to
your checksums.

<!-- START doctoc -->
## Table of contents

- [Two kinds of compression](#two-kinds-of-compression)
- [Compressed disc images: CHD, RVZ, Z3DS](#compressed-disc-images-chd-rvz-z3ds)
- [General archives: ZIP and 7z](#general-archives-zip-and-7z)
- [Trim, compress, or both](#trim-compress-or-both)
- [Compression changes your checksums](#compression-changes-your-checksums)
- [Which format should I choose?](#which-format-should-i-choose)

<!-- END doctoc -->

## Two kinds of compression

There are two different things people mean by "compressing a ROM", and they
behave differently.

A general archive such as ZIP or 7z wraps any file. To play the game, the
bytes usually have to come back out first, either by extracting or by an
emulator unpacking the archive itself.

A compressed disc image such as CHD or RVZ is a purpose-built container for
one disc. Emulators that support it read it directly, so the file stays small
on disk and still boots. When your console has one of these formats, it is
almost always the better choice.

## Compressed disc images: CHD, RVZ, Z3DS

**CHD** is the MAME-family container and the standard answer for CD- and
DVD-based consoles: PlayStation 1 and 2, Saturn, Sega CD, TurboGrafx-CD, and
Dreamcast GD-ROM discs all compress well into it, and emulators such as
DuckStation, PCSX2, and Flycast read it natively. rom-weaver creates CHD from
`.cue`/`.gdi`/`.iso` inputs, with output validated byte-for-byte against
chdman:

```bash
rom-weaver compress --input disc.cue --output disc.chd
```

**RVZ** is Dolphin's format for GameCube and Wii discs. It understands the
disc's own padding, so it shrinks images far beyond what a general archive
manages, and Dolphin plays it directly. rom-weaver's RVZ output matches
dolphin-tool byte for byte.

**Z3DS** is the zstd-compressed container for Nintendo 3DS images (`.z3ds`
and friends), read by Azahar-family emulators.

Formats rom-weaver can open but not create, like GCZ, WIA, WBFS, and CSO, are
worth converting: extract them and recompress into the modern format for that
console.

## General archives: ZIP and 7z

Cartridge ROMs are small, and many emulators load them straight from a ZIP.
That makes ZIP the safe default for NES through GBA-era files: universally
readable, fast, and good enough at these sizes. 7z compresses tighter but
fewer emulators open it directly, so it fits long-term storage more than a
play library. rom-weaver creates both, and the
[archive formats guide](formats.md) covers everyday extract and convert
workflows.

Avoid double-wrapping: a CHD inside a 7z gains almost nothing and has to be
extracted before it can boot.

## Trim, compress, or both

Some cartridge and disc formats carry padding rather than data. Trimming cuts
it off instead of squeezing it: rom-weaver trims NDS, GBA, and 3DS ROMs, Xbox
XISO images, and RVZ scrub candidates, and `--revert-marker` makes the trim
reversible byte for byte. For flashcarts and tight storage, a trimmed ROM
needs no decompression at all. The [trim support](../reference/formats.md#trim-support)
list has the details.

## Compression changes your checksums

A compressed file never hashes the same as the dump inside it, so a `.chd`
will not match a database entry for the `.bin` it was made from. That is
normal. rom-weaver's `probe` and `checksum` commands read inside supported
containers, so you can verify the payload without unpacking it. If a patch
guide expects a specific checksum, check it against the extracted image, and
see [Fix a checksum error](fix-checksum-errors.md) when it still disagrees.

## Which format should I choose?

- **CD/DVD console (PS1, PS2, Saturn, Sega CD, Dreamcast):** CHD.
- **GameCube or Wii:** RVZ.
- **Nintendo 3DS:** Z3DS.
- **Cartridge ROMs you play:** ZIP, or trimmed files where padding dominates.
- **Cold storage:** 7z for the tightest general-purpose ratio.
- **Already in GCZ, WIA, WBFS, or CSO:** convert to the modern format above.

The [Supported formats](../reference/formats.md#container-and-compression-formats)
reference is the authoritative table of every container, extension, and codec,
including the `--codec` values each output accepts. Back to the
[guide index](README.md).
