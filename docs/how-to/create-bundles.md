# Create and share a patch weave in the browser

Package an ordered patch recipe with expected ROM checksums into one download.

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

See [What a weave is](../explanation/bundles.md) for background, or try the [guided Weave Patches tour](https://rom-weaver.com/weave-patches?guide=weave) with homebrew files.

## Choose what to include

Leave **Include ROM in weave** clear for a patch-only release. The archive contains the recipe, patches, and expected ROM checksums. Each user supplies the matching ROM.

Select **Include ROM in weave** only for a ROM you can redistribute, such as your own homebrew. Packaging does not grant redistribution rights.

Choose ZIP for broad compatibility, or 7z. This selects the recipe archive format, not the recipient’s patched ROM container.

## Build the patch recipe

1. Open [Weave](https://rom-weaver.com/weave-patches).
2. Add the clean ROM and every patch.
3. Put the patches in execution order. Drag a numbered handle, click it to choose a position, or focus it and use the arrow keys.
4. Open each patch's three-dot **Patch actions** menu → **Edit details**. Add a readable name and any description, version, and author users need.
5. Open **Checks** → **Add check** for a known input or output CRC32, MD5, SHA-1, or byte count. Input checks describe the expected bytes. Embedded output checks verify the standalone result, not a combined stack whose earlier patches changed the source. Never guess values.

Set each patch's input selector to the state its checks describe:

1. Keep **auto** to let the checks select the state.
2. Choose **Original ROM** when the patch was made from the clean ROM.
3. Choose **Previous patch output** when the patch was made from the result above it.
4. Choose **Output of** a named patch for a dependency. Keep that patch enabled and ordered before its dependent patch.

For discs, select the required track. Keep accumulated execution to continue that track's chain. Test optional switches after reopening the exported weave.

Keep an explicit input and its target on the same track. Cross-track recipes require the [CLI](cli-apply.md); the browser rejects them before applying.

To include a disc ROM, add an archive containing the disc sheet and every track. A loose CUE or GDI sheet cannot package its track files.

Leave each required patch **On**. Turn a genuine add-on **Off** to make it optional and off by default.

Built-in checks, such as BPS checksums, cannot be edited. Add only values from the author or your tested Original and Modified files.

Reorder only when the patch supports that input state. Test optional combinations as described below, including dependencies.

<a id="turn-on-bundle-output-and-download-it"></a>

## Turn on weave output and download it

1. In the main **Weave** output step, enter the expected output name. It is also used to name the downloaded archive.
2. Choose **.zip** or **.7z** in its format selector.
3. Open **Options** and leave **Include ROM in weave** clear for a patch-only release.
4. Select **Share weave** and wait for the checks and download.
5. Save the archive. The control becomes **Download ZIP Weave** or **Download 7z Weave** for another copy.

Expand the secondary **Apply** step to test the recipe. Its name and compression settings are shared with Weave: 7z selects a 7z weave; other Apply formats select ZIP. Recheck the Weave format before sharing.

From an existing **Apply** session, export through **Share this patch recipe (for patch creators)**.

Checksums verify content; a filename mismatch alone does not block Apply.

Weave creation packages the staged recipe without applying it. Use **APPLY & DOWNLOAD** separately to build the patched ROM.

Files are read locally. Patch-only weaves contain ROM checksums, not ROM bytes.

## Test the finished download

Test the actual archive you will publish:

1. Open a fresh [Apply](https://rom-weaver.com/apply-patches) page.
2. Add the downloaded weave archive.
3. For a patch-only weave, add a fresh copy of the documented Original.
4. Confirm the displayed patch order, names, required switches, and optional switches match the release.
5. Run **APPLY & DOWNLOAD**.
6. Compare the result checksum with your intended Modified file.
7. Launch the result in the emulator or hardware you support.
8. Repeat for every optional combination you promise works.

Test rejection too: add a harmless wrong sample file and confirm the weave requests the matching ROM instead of producing output.

Compare the same checksum algorithm on both files. Playing tests only the paths you exercise, not every patch combination.

## Publish a useful release

Follow the [release-notes checklist](create-rom-patches.md#write-useful-release-notes). Also include the weave archive's checksum and a link to [Open a weave](apply-rom-patches.md#open-a-bundle).

Explain what the download changes on its release page; do not rely on the recipe alone.

For updates, rebuild from the same clean Original and new patches, update their details, and retest the archive from a fresh page.

<a id="open-a-hosted-bundle-in-apply"></a>

## Open a hosted weave in Apply

You can give users a link that preloads a public weave:

```text
https://rom-weaver.com/apply-patches?weave=https://example.com/release.zip
```

Recipient links use **Apply**; authors prepare and edit recipes in **Weave**.

The weave host must permit cross-origin browser downloads with CORS. The user's ROM still stays local. Relative patch URLs inside a remote recipe are resolved against the recipe URL.

See [webapp integration](../hosting/webapp-integration.md) for URL parameters, hosting headers, and errors, or the [CLI weave guide](cli-bundles.md) for scripted creation.
