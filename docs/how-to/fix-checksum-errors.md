# How to fix a source ROM checksum mismatch

A source ROM checksum mismatch means your ROM is not the file the patch expects: usually the wrong region or revision, a header, or an already patched copy.

Find the cause, then fix the input. An override skips the check; it does not repair the ROM.

<a id="fix-a-rom-checksum-mismatch-in-the-browser"></a>

<!-- START doctoc -->
## Table of contents

- [What does the warning mean?](#what-does-the-warning-mean)
- [Find the ROM the patch expects](#find-the-rom-the-patch-expects)
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

Apply reports it as **Not the expected ROM**. Other patchers word it differently: RomPatcher.js shows `Source ROM checksum mismatch`, and xdelta3 shows `target window checksum mismatch`. Each usually means the wrong starting file.

The checked bytes differ from the expected file. Compare the same algorithm in [Checksum file](https://rom-weaver.com/file-checksum). BPS/UPS carry checks; for IPS, use the author's notes. [Checksums versus filenames](../explanation/how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not) explains the evidence.

## Find the ROM the patch expects

A BPS or UPS patch records the CRC32 of the ROM it was made from. Look that value up to learn which release you need.

1. Open [Apply](https://rom-weaver.com/apply-rom-patches) and add your ROM and the patch.
2. Read the patch card's **Checks failed** message. It gives the CRC32 the patch expects and the CRC32 of your ROM.
3. Open a fresh [Identify page](https://rom-weaver.com/identify-rom).
4. Paste the expected CRC32 into **Identify by checksum or game name**, then select the release.
5. Return to [Apply](https://rom-weaver.com/apply-rom-patches) and drop your own copy of that release into **0x01 Inputs**. It replaces the wrong ROM.

For example, Identify names CRC32 `DD88761C` as `Pokemon - Fire Red Version (U) (V1.0) [!]`. It names `84EE4776` as `Pokemon - Fire Red Version (U) (V1.1) [!]`. A patch made from one fails on the other.

For IPS, xdelta, and other formats, take the expected checksum from the author's notes. [Search ROM checksums](search-rom-checksums-browser.md) covers lookup by CRC32, MD5, or SHA-1.

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

Once checks match, return to [Apply](https://rom-weaver.com/apply-rom-patches). See [why forcing a mismatch is risky](../explanation/how-patching-works.md#why-forcing-past-a-mismatch-is-risky) or [CLI validation](cli-apply.md#check-patches-without-writing-anything) for further diagnostics.
