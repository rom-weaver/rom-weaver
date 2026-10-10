# Create and share a patch weave in the browser

A rom-weaver weave packages an ordered patch recipe into one download. It helps users choose the right ROM, apply patches in the right order, and get the same result you tested.

<a id="create-and-share-a-patch-bundle-in-the-browser"></a>

<!-- START doctoc -->
## Table of contents

- [Choose what to include](#choose-what-to-include)
- [Build the patch recipe](#build-the-patch-recipe)
- [Turn on weave output and download it](#turn-on-weave-output-and-download-it)
- [Test the finished download](#test-the-finished-download)
- [Publish a useful release](#publish-a-useful-release)
- [Open a hosted weave in Apply](#open-a-hosted-weave-in-apply)

<!-- END doctoc -->

New to weaves? [What a weave is](../explanation/bundles.md) covers what one contains and when it is worth making, and the [guided Weave Patches tour](https://rom-weaver.com/weave-patches?guide=weave) builds one from the homebrew practice files.

## Choose what to include

Leave **Include ROM in weave** clear for a patch-only release. The archive contains the recipe, patches, and expected ROM checksums. Each user supplies the matching ROM.

Select **Include ROM in weave** only for a ROM you can redistribute, such as your own homebrew. Packaging does not grant redistribution rights.

Keep ZIP for a broadly readable download, or select 7z in the Weave format selector. This format controls the recipe archive, not the recipient’s patched ROM container.

## Build the patch recipe

1. Open [Weave](https://rom-weaver.com/weave-patches).
2. Add the clean ROM and every patch.
3. Put the patches in execution order. Drag a numbered handle, click it to choose a position, or focus it and use the arrow keys.
4. Open each patch's three-dot **Patch actions** menu and choose **Edit details**. Add a readable name and, when useful, a description, version, and author. People see this information when they open the weave.
5. Open **Checks** on each patch. Use **Add check** to record a known CRC32, MD5, SHA-1, or byte count for the input or output. Input checks describe the bytes the patch expects. Embedded output checks describe the patch’s standalone result. They do not verify a combined stack when earlier patches changed its source. Do not guess a value just to fill the form.

Set the input selector on each patch card. It chooses the state that the patch runs on, and the patch's input checks describe that same state:

1. Keep **auto** to let the checks select the state.
2. Choose **Original ROM** when the patch was made from the clean ROM.
3. Choose **Previous patch output** when the patch was made from the result above it.
4. Choose **Output of** a named patch when the patch depends on that patch's result. Keep each referenced patch enabled and before its dependent patch.

For a disc, use the track selector to select the required track. Keep accumulated execution to continue that track's selected patch chain. Turn each optional patch on and off after reopening the exported weave to check both results.

Keep an explicit input and its target on the same track in the browser. A recipe that reads one track and writes another requires the [CLI](cli-apply.md); the browser stops before applying that recipe.

To include a disc ROM, add an archive that contains the disc sheet and all track files. A loose CUE or GDI sheet cannot include its track files in the exported package.

Leave each required patch **On**. Turn a genuine add-on **Off** to make it optional and off by default.

Checks from formats such as BPS may already appear and cannot be edited. Add only checks you know are correct, such as values from the patch author or from the Original and Modified files you tested.

Order is part of the recipe. Move a card only when you know the patch was authored for that state. Test every optional combination you tell users is supported, especially when a later patch depends on an earlier one.

<a id="turn-on-bundle-output-and-download-it"></a>

## Turn on weave output and download it

1. In the main **Weave** output step, enter the expected output name. It is also used to name the downloaded archive.
2. Choose **.zip** or **.7z** in its format selector.
3. Open **Options** and leave **Include ROM in weave** clear for a patch-only release.
4. Select **Share weave** and wait for the checks and download.
5. Save the archive. The control becomes **Download ZIP Weave** or **Download 7z Weave** for another copy.

To test the patched ROM from the same session, expand the secondary **Apply** step. Its name and compression settings are shared with Weave: choosing 7z selects a 7z weave, while other Apply output formats select ZIP. Recheck the Weave format after changing Apply settings. The recipe archive format does not force the recipient’s final ROM container.

If you already have a recipe staged on **Apply**, open **Share this patch recipe (for patch creators)** there to export it.

The expected filename helps users find the ROM. Checksums establish whether its contents match; a different filename alone does not block applying.

Weave creation does not apply the patches. It packages the recipe you have staged. **APPLY & DOWNLOAD** remains available separately when you also want to build the patched output.

Your ROM and patches are read locally. A patch-only weave carries the ROM's checksums, not its bytes.

## Test the finished download

Test the archive you will publish, not only the loose files used to make it:

1. Open a fresh [Apply](https://rom-weaver.com/apply-patches) page.
2. Add the downloaded weave archive.
3. For a patch-only weave, add a fresh copy of the documented Original.
4. Confirm the displayed patch order, names, required switches, and optional switches match the release.
5. Run **APPLY & DOWNLOAD**.
6. Compare the result checksum with your intended Modified file.
7. Launch the result in the emulator or hardware you support.
8. Repeat for every optional combination you promise works.

Also test the failure path. Add a harmless wrong sample file and make sure the weave clearly asks for the matching ROM rather than silently producing an output.

Compare the same checksum algorithm on both files to check reconstruction. Playing the result tests the paths you exercise; it does not establish that every patch combination works.

## Publish a useful release

Follow the [release-notes checklist](create-rom-patches.md#write-useful-release-notes). Also include the weave archive's checksum and a link to [Open a weave](apply-rom-patches.md#open-a-bundle).

Do not rely on the recipe as the only human explanation. Someone should be able to read the release page and understand what the download changes before opening it.

For an update, rebuild the recipe from the same clean Original and the new patch files. Update the patch details and test the new archive from a fresh page.

<a id="open-a-hosted-bundle-in-apply"></a>

## Open a hosted weave in Apply

You can give users a link that preloads a public weave:

```text
https://rom-weaver.com/apply-patches?weave=https://example.com/release.zip
```

Use **Apply** for recipient links so patching is the primary action. **Weave** is for authors preparing or editing the recipe.

The weave host must permit cross-origin browser downloads with CORS. The user's ROM still stays local. Relative patch URLs inside a remote recipe are resolved against the recipe URL.

The [webapp integration guide](../hosting/webapp-integration.md) covers multiple URL parameters, same-origin files, hosting headers, and error handling. For scripted weave creation, use the [CLI weave guide](cli-bundles.md).
