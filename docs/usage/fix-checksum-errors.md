# Fix a checksum error

rom-weaver says your file is not the one the patch expects. That warning is
almost always right, and this guide finds out why.

<!-- START doctoc -->
## Table of contents

- [What the warning actually means](#what-the-warning-actually-means)
- [Work through it in this order](#work-through-it-in-this-order)
- [Wrong region or wrong revision](#wrong-region-or-wrong-revision)
- [The header problem](#the-header-problem)
- [Nintendo 64 byte order](#nintendo-64-byte-order)
- [Patches in the wrong order](#patches-in-the-wrong-order)
- [Do not force it](#do-not-force-it)

<!-- END doctoc -->

## What the warning actually means

A checksum is a short code worked out from every byte in a file. Change one
byte anywhere and the code changes completely. Rename the file and the code
stays the same, because the name is not part of the file's contents.

So when your checksum does not match the one the patch expects, your file
differs from the author's by at least one byte. Not "probably". At least one.

BPS and UPS patches carry the expected checksums inside them, which is how
rom-weaver can complain before it writes anything. Other formats carry
nothing, so the author has to publish a CRC32, MD5, SHA-1, or SHA-256 value in
their notes. Compare like with like: a CRC32 and a SHA-256 of the same file
share no digits.

In the browser, the checksums appear once you pick a ROM. In a terminal:

```bash
rom-weaver checksum --input game.sfc --algo sha256
```

Swap `sha256` for whichever one the author published. rom-weaver handles
CRC32, MD5, SHA-1, SHA-256, BLAKE3, CRC32C, CRC16, and Adler-32.

## Work through it in this order

Change one thing at a time. Changing three and retrying teaches you nothing.

1. Reread the author's notes. Write down the region, the revision, anything
   about headers or disc layout, the patch order, and the checksum.
2. Go back to a clean file. Not one that has already been translated,
   trimmed, trained, or patched by something else.
3. Work out its checksum with the algorithm the author named.
4. If your file came out of an archive, confirm the entry you picked is the
   ROM and not a readme, a save file, or a second dump.
5. Check the header, and on Nintendo 64, the byte order. Both are covered
   below.
6. If several patches are involved, work out which one expects the clean file
   and which expects the output of an earlier one.
7. Try again only once you can name what was different.

Most mismatches are one of the four causes below.

## Wrong region or wrong revision

This is the common one.

USA, Japan, and European releases of the same game are different files. Text,
code, and data all sit in different places. A patch built against one will not
apply cleanly to another.

Revisions are sneakier. A Rev 1 is the same game with bugs fixed after launch.
It boots the same, plays the same, and shows the same title screen, while
differing at exactly the offsets a patch wants to change. You cannot tell them
apart by looking. You can tell them apart by checksum.

Use the exact release the author named.

## The header problem

Some cartridge dumps carry a small block of extra bytes at the front, added by
the copier hardware people used to dump them. It is usually 512 bytes. It is
not part of the game.

The trouble is that a patch was built against a file that either had that
block or did not, and the two forms have different checksums. Same game,
different bytes at the front, so every offset after it is shifted.

rom-weaver checks both forms for you and picks whichever one the patch proves
it wants, whenever the patch carries enough information to prove it. When it
does not, you can decide:

- `--patch-header auto|keep|strip` controls what each patch is handed.
- `--output-header auto|keep|strip` controls what the finished file keeps.

`auto` is the default for both and is usually right. Do not strip a header on
a hunch. Compare the checksums with and without it against the author's notes
first, then you will know rather than guess.

## Nintendo 64 byte order

Nintendo 64 dumps circulate with their bytes arranged in three different
orders, usually signaled by the extension: `.z64`, `.v64`, and `.n64`. All
three hold the same game. All three have different checksums, because the
bytes really are in a different sequence.

A patch matches one of them. So:

```text
--n64-byte-order auto|keep|big-endian|little-endian|byte-swapped
```

`auto` is the default. It works out which order the patch's own checksum
names, rearranges the file to match, and writes the result back in the order
your input arrived in. Leave it alone unless you have a reason.

## Patches in the wrong order

In a release with several patches, they run one after another, each on the
result of the last. A later patch usually expects an earlier patch's output,
not the clean game. Feed it the clean game and you get a checksum error that
looks exactly like a wrong-region error.

Repeat `--patch` in the documented order, or drag the cards into that order in
the browser. You can test a chain without writing any file:

```bash
rom-weaver patch validate \
  --input original.sfc \
  --patch base.bps \
  --patch fixes.ips
```

Each patch is checked against the output of the one before it, which is what
happens for real, so this tells you where the chain breaks.

## Do not force it

`--ignore-checksum-validation` exists, and it does not make the wrong file
right. It skips the check. The bytes are still wrong.

A forced patch usually writes a file. That file may boot. It may even play for
a while. Then it crashes, or an item is missing, or the save corrupts twenty
hours in, and by then nobody remembers the warning. The flag is there for
research and recovery work, not for getting past a red message.

If you cannot work out which file you are supposed to have, ask. The patch
author or the project's community can tell you the exact checksum and
revision. Do not go hunting on a random download site to make the warning stop.

Once the checksum matches, carry on with [Apply a patch](apply-rom-patches.md),
and keep that verified original somewhere safe for next time. Back to the
[guide index](README.md).
