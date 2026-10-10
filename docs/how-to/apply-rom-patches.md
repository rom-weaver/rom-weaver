# How to apply BPS, IPS, UPS, and xdelta patches

Apply BPS, IPS, UPS, or xdelta patches to your own ROM in the browser. Check the source, choose an output, and download the patched file. No uploads or account.

<a id="apply-bps-ips-ups-and-xdelta-rom-patches-online"></a>

<a id="rom-patcher-online-apply-bps-ips-ups-and-xdelta-patches"></a>

<!-- START doctoc -->
## Table of contents

- [What do you need?](#what-do-you-need)
- [Add the files](#add-the-files)
- [Apply a BPS patch](#apply-a-bps-patch)
- [Apply an IPS or IPS32 patch](#apply-an-ips-or-ips32-patch)
- [Apply a UPS patch](#apply-a-ups-patch)
- [Apply an xdelta or VCDIFF patch](#apply-an-xdelta-or-vcdiff-patch)
- [Apply a PPF patch](#apply-a-ppf-patch)
- [Apply APS, APSGBA, RUP, and other patch formats](#apply-aps-apsgba-rup-and-other-patch-formats)
- [Apply an HDiffPatch or HPatchZ patch](#apply-an-hdiffpatch-or-hpatchz-patch)
- [Dreamcast DCP patches need the CLI](#dreamcast-dcp-patches-need-the-cli)
- [Read the ROM and patch cards](#read-the-rom-and-patch-cards)
- [Put several patches in order](#put-several-patches-in-order)
- [Add cheats to the patch order](#add-cheats-to-the-patch-order)
- [Choose the output and apply](#choose-the-output-and-apply)
- [Open a weave](#open-a-weave)
- [If the ROM does not match](#if-the-rom-does-not-match)
- [Use the result safely](#use-the-result-safely)

<!-- END doctoc -->

## What do you need?

Keep a clean ROM, the patch, and the author's notes. Match region, revision, checksum algorithm and digest, header state, and patch order. ZIP/7z/RAR files are containers; changing a patch's extension cannot fix a ROM mismatch. See [patch formats](../explanation/patch-formats.md) or the [tool comparison](../explanation/comparisons.md#applying-a-patch).

Without the source file, use **Identify by checksum or game name** below the empty drop zone or in **0x02 ROM**. Search a checksum, or choose a game, system, region, and revision. The card shows locally indexed checksums and size. This search appears only when a weave or patch has not already named the expected source.

## Add the files

1. Open [Apply](https://rom-weaver.com/apply-patches).
2. Drop the ROM and patch into **0x01 Inputs**, or choose **Add files**. A folder or [supported archive](../reference/formats.md#container-and-compression-formats) also works; nested archives, CHD, and RVZ are unpacked.
3. Wait for **Reading** and **Checksumming**. If asked, choose the entry the author named.

The resulting cards separate **ROM**, **Patches & Cheats**, and **Apply** controls. To change only the container, use [Convert](convert-roms-browser.md).

New here? [Your first patch](../tutorials/first-patch.md) supplies homebrew files. [Guided Apply](https://rom-weaver.com/apply-patches?guide=apply) waits for your files; **Continue** with none loads samples. The [cheats tour](https://rom-weaver.com/apply-patches?guide=apply-cheats) supplies a sample code. [Input routes](../reference/guided-runs.md#ways-files-get-into-apply) lists other ways to add files.

## Apply a BPS patch

1. Open [Apply](https://rom-weaver.com/apply-patches) and add your clean ROM and `.bps` file to **0x01 Inputs**.
2. Wait for checksumming, then open **Checks**. BPS stores the expected source CRC32; resolve any [mismatch](fix-checksum-errors.md) before continuing.
3. In **Apply**, choose the output name and format, then select **APPLY & DOWNLOAD**.
4. Save the new ROM and [test it](test-roms-in-browser.md#test-an-apply-result). Your Original stays untouched.

A `.bps` file is a patch, not a playable ROM. For multiple patches, check [order and inputs](#put-several-patches-in-order); for output options, see [choose the output and apply](#choose-the-output-and-apply).

## Apply an IPS or IPS32 patch

Add the `.ips`/`.ips32` and source. These formats contain no source checksum: compare the author's digest using [Checksum](checksum-roms-browser.md) and check the header state. Successful application alone does not prove the ROM is correct.

## Apply a UPS patch

Add the `.ups` and clean source. Check the card's input checks; resolve [region, revision, or header mismatches](fix-checksum-errors.md) before applying.

## Apply an xdelta or VCDIFF patch

Add the supplied `.xdelta`, `.delta`, `.dat`, or `.vcdiff` and the exact image or track named by the author. Source checks depend on how the patch was made; compare any published source digest before applying.

## Apply a PPF patch

Add the `.ppf` and exact ROM or track. Check the image layout and checksum; include the CUE and every BIN track for a BIN/CUE disc. For PPF3 undo data, see [Undo PPF](undo-ppf-browser.md).

## Apply APS, APSGBA, RUP, and other patch formats

The same input steps cover APS, APSGBA, RUP, SOLID, GDIFF, PAT/FireFlower, EBP, BDF/BSDIFF40, BSP, MOD/PMSR, DLDI, and DPS. Check the detected format and the author's source digest. The [reference](../reference/formats.md#patch-formats) lists extensions and creation support.

## Apply an HDiffPatch or HPatchZ patch

Add a single-file `.hdiff`/`.hpatchz` and its matching source. Check the author's digest. Directory patches marked `HDIFF19` are unsupported; use the author's directory-patching tool.

## Dreamcast DCP patches need the CLI

Use the [CLI DCP procedure](cli-apply.md#apply-a-dreamcast-dcp-patch); browser Apply lacks that disc-sheet workflow. NINJA1 and PDS cannot be applied. See [support limits](../reference/formats.md#patch-formats).

## Read the ROM and patch cards

The ROM card shows filename, size, system, and checksums. A filename mismatch is advisory; checksum or size mismatches are strict. Open **Checks** for details.

Patch cards show format, position, and input/output checks. The three-dot **Patch actions** menu edits details, replaces the file, or removes it. Header controls appear where applicable.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="../screenshots/apply-patches-mobile-light.avif" width="1170" height="1433">
    <source type="image/avif" srcset="../screenshots/apply-patches-desktop-light.avif" width="1770" height="788">
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/apply-patches-mobile-light.webp" width="1170" height="1433">
    <img src="../screenshots/apply-patches-desktop-light.webp" alt="Cropped Apply patch stack with two ordered practice patches in the light theme" width="1770" height="788">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="../screenshots/apply-patches-mobile-dark.avif" width="1170" height="1433">
    <source type="image/avif" srcset="../screenshots/apply-patches-desktop-dark.avif" width="1770" height="788">
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/apply-patches-mobile-dark.webp" width="1170" height="1433">
    <img src="../screenshots/apply-patches-desktop-dark.webp" alt="Cropped Apply patch stack with two ordered practice patches in the dark theme" width="1770" height="788">
  </picture>
  <figcaption>Patches run from top to bottom. Each card shows the checks for that step.</figcaption>
</figure>

## Put several patches in order

Patches run top to bottom. Each input selector chooses the state it modifies: keep **auto** for checksum inference, **Original ROM** for the clean source, or **Previous patch output** for the preceding result.

Drag a numbered handle to reorder; keyboard users can focus it and follow its announced controls. Switch optional patches **On** or **Off** only in tested combinations. Skipping a required base can break dependent patches.

Recheck **Checks** after changing order, inputs, or switches. Input checks describe the authored state. Embedded output checks describe a standalone patch's result, not necessarily the combined stack.

[Patch the supplied synthetic CHD](../tutorials/patch-compressed-disc.md) for a verified example: `01-first.bps` reads the Original; `02-second.bps` requires its output. The tutorial supplies intermediate and final checksums. Use your author's tested states for your own files.

## Add cheats to the patch order

In **Patches & Cheats**, select **Add cheats to the patch order**, then choose database entries or **Add code manually**. Place each code where it must run; it changes the preceding result. Check game/revision when matching by title, and resolve unsupported-code or write-conflict errors. [Use cheats](use-browser-cheats.md) covers validation, export, and offline use.

## Choose the output and apply

If **APPLY & DOWNLOAD** is disabled, wait for checksumming and resolve the nearby warning. In **Apply**:

1. Enter a filename without an extension.
2. Pick a plain file unless the author or emulator requires compression; the selector adds the extension.
3. Open **Options** for compression, output header, or weave controls when needed.
4. Choose **APPLY & DOWNLOAD**, wait, and save the new file.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="../screenshots/apply-output-mobile-light.avif" width="1170" height="795">
    <source type="image/avif" srcset="../screenshots/apply-output-desktop-light.avif" width="1770" height="676">
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/apply-output-mobile-light.webp" width="1170" height="795">
    <img src="../screenshots/apply-output-desktop-light.webp" alt="Cropped Apply output card with filename, format, options, and APPLY &amp; DOWNLOAD button in the light theme" width="1770" height="676">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="../screenshots/apply-output-mobile-dark.avif" width="1170" height="795">
    <source type="image/avif" srcset="../screenshots/apply-output-desktop-dark.avif" width="1770" height="676">
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/apply-output-mobile-dark.webp" width="1170" height="795">
    <img src="../screenshots/apply-output-desktop-dark.webp" alt="Cropped Apply output card with filename, format, options, and APPLY &amp; DOWNLOAD button in the dark theme" width="1770" height="676">
  </picture>
  <figcaption>Choose the output name and format before applying.</figcaption>
</figure>

<a id="open-a-bundle"></a>

## Open a weave

Add the [weave recipe](../explanation/bundles.md) to **0x01 Inputs**, or open the author's preload link. Supply the matching ROM for a patch-only weave, review optional switches, and use **APPLY & DOWNLOAD**. To publish one, follow [Create a weave](create-bundles.md).

## If the ROM does not match

[Fix checksum errors](fix-checksum-errors.md) checks region, revision, archive selection, headers, byte order, patch order, and earlier edits. Do not bypass a mismatch to repair it.

## Use the result safely

[Test supported ROMs in the browser](test-roms-in-browser.md#test-an-apply-result), or use your emulator/hardware. Exercise the modified parts; reaching the title screen does not prove every combination works. Keep the clean Original and name the output by project/version.

For automation, see [CLI Apply](cli-apply.md); to author changes, see [Create a patch](create-rom-patches.md). [Files stay local](../explanation/local-first.md).
