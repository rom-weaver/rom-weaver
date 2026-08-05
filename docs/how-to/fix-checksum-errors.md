# Fix a checksum error in the browser

rom-weaver says the bytes do not match what a patch or bundle expects. Stop
there and find the difference before creating an output.

<!-- START doctoc -->
## Table of contents

- [What does the warning mean?](#what-does-the-warning-mean)
- [Which messages are strict?](#which-messages-are-strict)
- [Check these causes in order](#check-these-causes-in-order)
- [Wrong region or revision](#wrong-region-or-revision)
- [Wrong file inside an archive](#wrong-file-inside-an-archive)
- [Cartridge header differences](#cartridge-header-differences)
- [Nintendo 64 byte order](#nintendo-64-byte-order)
- [Wrong patch order](#wrong-patch-order)
- [Already modified files](#already-modified-files)

<!-- END doctoc -->

## What does the warning mean?

Your file differs from the expected file by at least one byte, so continuing
would use a different starting point from the one the patch author tested.
[What a checksum proves](../explanation/how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not)
covers why the fingerprint, not the filename, is the verdict.

BPS and UPS can carry expected checksums inside the patch. Other formats, such
as IPS, may not know what Original they need. In those cases, compare the
checksums shown by rom-weaver with the values in the author's notes.

Compare the same algorithm. CRC32, SHA-1, and SHA-256 fingerprints for one file
look unrelated.

## Which messages are strict?

The Apply cards separate clues from proof.

An expected filename mismatch is advisory. Authors often write a useful name
into a bundle, but users may legally dump or rename the same bytes under
another name. If size and checksum match, a different name alone does not make
the ROM wrong.

An expected checksum mismatch is strict. An expected size mismatch is also
strict. Those messages describe the file contents, not the label on the file.

Open **Checks** on the ROM and patch cards. Read the expected value and actual
value carefully. A green match means that exact check passed at that step. A
red mismatch is the problem to solve.

## Check these causes in order

Change one thing at a time:

1. Reread the release notes. Write down region, revision, checksum algorithm,
   header state, disc layout, and patch order.
2. Return to a clean Original. Do not use a file that was already patched,
   trimmed, trained, or edited.
3. Confirm the ROM card shows the file you meant to select.
4. Compare its checksum with the author's value using the same algorithm.
5. If the ROM came from an archive, confirm the selected entry.
6. Check the cartridge header or Nintendo 64 byte order when relevant.
7. Put patches back into the documented order.
8. Retry only after you can name what changed.

Most problems are found in the first four steps.

## Wrong region or revision

USA, Japanese, and European releases of the same title are different files.
Text, code, timing, and data may sit at different offsets. A patch built for
one release will not safely apply to another.

Revisions are harder to spot. Rev 1 may look and play like Rev 0 while fixing a
few bytes at the exact locations a patch changes. The title screen cannot tell
you which one you have. The checksum can.

Use the exact release the author documented. Do not hunt for a random download
with a promising filename. Ask the author or community for the expected
checksum and release details.

## Wrong file inside an archive

An archive may contain several ROMs, disc tracks, save files, readmes, or
regional variants. rom-weaver asks you to choose when it cannot prove one
candidate is correct.

Open the archive's file list in the card and compare it with the release notes.
For a multi-track disc, keep the cue sheet and all tracks together. Choosing a
large `.bin` file just because it looks important can still select the wrong
track or layout.

Remove the wrong card, add the archive again, and choose the correct entry.
Then compare the checksum before patching.

## Cartridge header differences

Some cartridge dumps have a small copier header before the game data. A
common size is 512 bytes. The header is not part of the game, but it shifts
every later byte and changes the checksum.

rom-weaver checks headered and headerless forms when the patch provides enough
information. The patch card's **Options** can show header handling for systems
where it applies.

Leave automatic handling selected unless the author gives a reason to change
it. Do not strip a header on a hunch. Compare the card's checks with the
author's expected value first.

The output header is a separate choice. One setting controls the bytes a patch
receives, while the output setting controls the form of the downloaded result.

## Nintendo 64 byte order

Nintendo 64 dumps are commonly stored in three byte orders, often indicated by
`.z64`, `.v64`, and `.n64`. They can represent the same game while producing
different checksums because their bytes are arranged differently.

Automatic handling tries the order proved by the patch checksum and writes the
result back in the input's order. Keep automatic handling unless the release
notes explicitly require another form.

An extension is still only a clue. Use the checksum in the ROM card to identify
the actual bytes.

## Wrong patch order

With several patches, each one runs on the previous patch's result. A later
patch may expect the translation output, not the clean game.

In **0x03 Patches**, drag the numbered handles into the author's order. Open
**Checks** on each card. The expected input for one step should match the
actual output state from the step above it.

Do not turn off a required base patch to get past a warning. Optional switches
are safe only for combinations the release author tested.

If you started from a bundle, its saved order should already be correct. A
manual reorder is a sign to reread the bundle's release notes.

## Already modified files

Translations, trainers, patches from another project, trimming tools, and save
data can all change a ROM. A file may boot normally and still be the wrong
Original.

Go back to the clean copy you preserved before patching. If you do not have a
known-good copy, obtain it again through the same legal dumping process and
check its fingerprint.

Do not use the output from an older release unless the new patch explicitly
says it is incremental.

Do not reach for the checksum override to get past a mismatch - it skips the
check without repairing the file, and the result can fail hours into play.
[Why forcing past a mismatch is risky](../explanation/how-patching-works.md#why-forcing-past-a-mismatch-is-risky)
explains what an override is actually for.

Once the checks match, return to
[Apply a ROM patch](apply-rom-patches.md). If you need terminal diagnostics,
see
[Check patches without writing anything](cli-apply.md#check-patches-without-writing-anything).
The [FAQ](../faq.md) covers related filename, privacy, and format questions.
