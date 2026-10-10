# Fix a ROM checksum mismatch in the browser

When Apply reports **Not the expected ROM**, check the source and patch order. An override bypasses verification; it does not repair the input.

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

The checked bytes differ from the expected file. Compare the same algorithm in [Checksum file](https://rom-weaver.com/checksum). BPS/UPS carry checks; for IPS, use the author's notes. [Checksums versus filenames](../explanation/how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not) explains the evidence.

## Which messages are strict?

Open the cards' **Checks**. A different filename is advisory if size and checksums match. A size or checksum mismatch needs investigation.

## Check these causes in order

1. Confirm the author's region, revision, header state, checksum algorithm, disc layout, and patch order. Ask for missing details.
2. Select a clean Original. Use [Identify](https://rom-weaver.com/identify-rom) for an unknown source.
3. Compare extracted ROM/track checksums, not ZIP, RVZ, or CHD container hashes.
4. Check the relevant cause below; change one thing at a time.

## Wrong region or revision

Use the documented release. Similar filenames or title screens cannot prove identical bytes across regions or revisions.

## Wrong file inside an archive

Inspect the card's file list. Choose the expected ROM or track, not simply the largest BIN. Keep CUE/GDI sheets and companion tracks together. Remove and re-add the archive to correct a selection.

## Cartridge header differences

A copier header, often 512 bytes, changes offsets and checksums. Keep automatic handling unless instructed otherwise; inspect the patch's **Options**. rom-weaver checks headered/headerless forms when patch evidence permits. Input handling and the downloaded output's header are separate choices.

## Nintendo 64 byte order

`.z64`, `.v64`, and `.n64` commonly use different byte orders. Automatic handling tries the order proved by the checksum and restores the input order on output. Extensions alone are not proof.

## Wrong patch order

If the first patch passes but the next fails, check each input selector and **Checks**. A dependent patch must follow the result it expects; **Original ROM** reads the clean source. Restore the author's order and required switches. Use only tested optional combinations.

## Already modified files

Return to the clean copy unless the release explicitly requires an incremental input. Patched, trained, trimmed, or edited files can still boot while having wrong bytes. If needed, repeat your legal dumping process.

Once checks match, return to [Apply](https://rom-weaver.com/apply-patches). See [why forcing a mismatch is risky](../explanation/how-patching-works.md#why-forcing-past-a-mismatch-is-risky) or [CLI validation](cli-apply.md#check-patches-without-writing-anything) for further diagnostics.
