# How ROM patching works

Why a patch needs one exact starting file, what a checksum proves, why order matters, and what every word in the interface means. Nothing here is a procedure - it is the background that makes the procedures make sense.

<!-- START doctoc -->
## Table of contents

- [A patch is not a game](#a-patch-is-not-a-game)
- [Why the exact starting file matters](#why-the-exact-starting-file-matters)
- [What a checksum proves, and what a filename does not](#what-a-checksum-proves-and-what-a-filename-does-not)
- [Why forcing past a mismatch is risky](#why-forcing-past-a-mismatch-is-risky)
- [Why patch order matters](#why-patch-order-matters)
- [Compression changes the bytes](#compression-changes-the-bytes)
- [Words used in the interface](#words-used-in-the-interface)
- [Related](#related)

<!-- END doctoc -->

## A patch is not a game

A ROM is a copy of a game stored in one or more files. A patch is a much smaller file that describes changes to one exact version of that game. The change might be a translation, a bug fix, restored content, or a new set of levels.

Think of a patch as a list that says "replace these bytes with those bytes." You supply your own clean game file. rom-weaver combines the two and writes a new file, leaving the clean file alone.

This is also why a patch release is legal to distribute where the game is not. A patch contains the author's changes, not the game. rom-weaver ships no game data of its own; the guided samples are homebrew ROMs written for this project.

## Why the exact starting file matters

A USA release and a Japanese release may look like the same game, but their bytes differ. The same is true for revisions, for cartridge headers, and for Nintendo 64 byte order. A patch written for one will usually reject the others, and the ones that do not reject it will produce a broken file.

The patch author picked one file. Your job is to start from that same file. Everything rom-weaver shows you on the ROM card exists to tell you whether you did.

## What a checksum proves, and what a filename does not

A checksum is a fingerprint calculated from every byte in a file. If two files have the same checksum, their bytes are the same. Renaming a file does not change its checksum, and no amount of correct-looking metadata can fake one.

A filename proves nothing. The author may have named the ROM one way while your dumping tool named the same bytes another way. Two different files can carry the same name.

So rom-weaver treats them differently:

- A **name** mismatch is a warning. It is a hint, not a verdict.
- A **size or checksum** mismatch is strict. The bytes differ, and something needs to be fixed before you continue.

When a checksum disagrees, the fix is to find the right starting file, not to switch patch formats and not to enable an override. [Fix a checksum error](../how-to/fix-checksum-errors.md) works through the usual causes.

## Why forcing past a mismatch is risky

A checksum override skips the safety check. It does not repair the file.

The patch may still create a result that boots and fails much later. Code can jump to the wrong data, text can overwrite another table, or a save can become corrupt hours into play. A successful output is not proof of a correct result.

Overrides exist for authors doing controlled research and recovery. For normal use, the matching original is the fix.

## Why patch order matters

Patch sets use two relationships. Independent patches are made from the same original ROM. Dependent patches are made from the result of an earlier patch.

rom-weaver applies both kinds to one accumulated result. It uses the input rule to verify each patch against the state that its author used.

Order still matters. Later changes can overlap earlier changes, and a dependent patch must follow the result it expects.

Only the author knows the intended rule and order. A bundle records both values so users do not reconstruct them from filenames.

## Compression changes the bytes

A compressed file does not hash the same as the dump inside it, so a `.chd` will not match a database entry for the `.bin` it was made from. That is expected, not a fault. rom-weaver's `checksum` command unwraps many containers automatically so you compare the payload rather than the wrapper.

[Choosing a compression format](compression-formats.md) covers what each container is for.

## Words used in the interface

- **ROM**: the game file you already have.
- **Patch**: the smaller file that describes changes to one ROM.
- **Original**: the clean, unchanged ROM a patch was created from.
- **Modified**: the finished ROM a patch was created against.
- **Checksum**: a fingerprint calculated from every byte in a file.
- **Region**: the market a release was made for, such as USA, Japan, or Europe.
- **Revision**: a later printing of the same game.
- **Header**: extra bytes added to the front of some cartridge dumps.
- **Patch order**: the sequence used when several patches build on one another.
- **Bundle**: a recipe that records a ROM's checks, patch files, order, choices, and output settings. See [What a bundle is](bundles.md).

You do not need to memorize this. The cards in the webapp surface each of these where it matters.

## Related

- [Choosing a patch format](patch-formats.md) when you are the one publishing.
- [Why your files stay on your device](local-first.md) for what rom-weaver does and does not send anywhere.
- [Supported formats](../reference/formats.md) for the authoritative tables.
