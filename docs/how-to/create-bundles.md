# Create and share a patch bundle in the browser

A rom-weaver bundle packages an ordered patch recipe into one download. It helps users choose the right ROM, apply patches in the right order, and get the same result you tested.

<!-- START doctoc -->
## Table of contents

- [Choose what to include](#choose-what-to-include)
- [Build the patch recipe](#build-the-patch-recipe)
- [Turn on bundle output and download it](#turn-on-bundle-output-and-download-it)
- [Test the finished download](#test-the-finished-download)
- [Publish a useful release](#publish-a-useful-release)
- [Open a hosted bundle in Apply](#open-a-hosted-bundle-in-apply)

<!-- END doctoc -->

New to bundles? [What a bundle is](../explanation/bundles.md) covers what one contains and when it is worth making, and the [guided Bundle tour](https://rom-weaver.com/apply?guide=bundle) builds one from the homebrew practice files.

## Choose what to include

Use **Bundle + patches** for a normal public release. It includes the recipe and patches. It records checksums for the expected ROM but does not include that ROM. Each user supplies their own legal copy.

Use **Bundle + ROM + patches** only for homebrew, your own backups, public domain material, or another ROM you are allowed to redistribute. A convenient button does not grant permission to share copyrighted game data.

Choose ZIP unless your audience specifically wants 7z. Browsers and operating systems open ZIP easily. ZIP and 7z contain the same recipe information.

## Build the patch recipe

1. Open [Apply](https://rom-weaver.com/apply).
2. Add the clean ROM and every patch.
3. Put the patches in execution order. Drag a numbered handle, click it to choose a position, or focus it and use the arrow keys.
4. Open each patch's three-dot **Patch actions** menu and choose **Edit details**. Add a readable name and, when useful, a description, version, and author. People see this information when they open the bundle.
5. Open **Checks** on each patch. Use **Add check** to record a known CRC32, MD5, SHA-1, or byte count for the input or output. Input checks describe the bytes the patch expects. Output checks describe the bytes it creates. Do not guess a value just to fill the form.

Set the input selector on each patch card:

1. Keep **Automatic** when the patch checks must select its input.
2. Choose **Original ROM** when the patch was made from the clean ROM.
3. Choose **Previous patch output** when the patch was made from the result above it.

Leave each required patch **On**. Turn a genuine add-on **Off** to make it optional and off by default.

Checks from formats such as BPS may already appear and cannot be edited. Add only checks you know are correct, such as values from the patch author or from the Original and Modified files you tested.

Order is part of the recipe. Move a card only when you know the patch was authored for that state. Test every optional combination you tell users is supported, especially when a later patch depends on an earlier one.

## Turn on bundle output and download it

In **0x04 Apply**:

1. Set the output filename and format users should receive after patching.
2. Open **Options**.
3. Find **Bundle**. It starts at **Hide bundle creation**. Turn bundle output on by choosing **Bundle + patches (.zip)** for a normal public release.
4. Confirm or edit **Expected source ROM filename**. This name helps users find the ROM. Checksums prove that its contents match.
5. Clear the filename to omit the name hint. A different name warns without blocking the weave.

Create the download:

1. Choose **Create ZIP Bundle**.
2. Wait while rom-weaver calculates checksums and checks the recipe.
3. When the button changes to **Download ZIP Bundle**, choose it and save the archive.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/bundle-output-mobile-light.avif" width="1170" height="2013">
    <source type="image/avif" srcset="/docs/screenshots/bundle-output-desktop-light.avif" width="2242" height="1399">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/bundle-output-mobile-light.webp" width="1170" height="2013">
    <img src="/docs/screenshots/bundle-output-desktop-light.webp" width="2242" height="1399" alt="Cropped Apply output card with Bundle plus patches ZIP selected and the Create ZIP Bundle control in the light theme">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="/docs/screenshots/bundle-output-mobile-dark.avif" width="1170" height="2013">
    <source type="image/avif" srcset="/docs/screenshots/bundle-output-desktop-dark.avif" width="2242" height="1399">
    <source media="(max-width: 520px)" type="image/webp" srcset="/docs/screenshots/bundle-output-mobile-dark.webp" width="1170" height="2013">
    <img src="/docs/screenshots/bundle-output-desktop-dark.webp" width="2242" height="1399" alt="Cropped Apply output card with Bundle plus patches ZIP selected and the Create ZIP Bundle control in the dark theme">
  </picture>
  <figcaption>The bundle setting lives inside Output Options. The focused capture keeps the selector and action readable.</figcaption>
</figure>

Bundle creation does not apply the patches. It packages the recipe you have staged. **APPLY & DOWNLOAD** remains available separately when you also want to build the patched output.

Your ROM and patches are read locally. A patch-only bundle carries the ROM's checksums, not its bytes.

## Test the finished download

Test the archive you will publish, not only the loose files used to make it:

1. Open a fresh [Apply](https://rom-weaver.com/apply) page.
2. Add the downloaded bundle archive.
3. For a patch-only bundle, add a fresh copy of the documented Original.
4. Confirm the displayed patch order, names, required switches, and optional switches match the release.
5. Run **APPLY & DOWNLOAD**.
6. Compare the result checksum with your intended Modified file.
7. Launch the result in the emulator or hardware you support.
8. Repeat for every optional combination you promise works.

Also test the failure path. Add a harmless wrong sample file and make sure the bundle clearly asks for the matching ROM rather than silently producing an output.

A matching checksum proves byte-for-byte reconstruction. Launching the result proves that the reconstructed file works. These are different checks.

## Publish a useful release

Publish the tested bundle archive with:

- project name and version;
- a short changelog;
- expected Original region and revision;
- the Original checksum and algorithm;
- the expected output checksum and algorithm;
- which patches are optional;
- the bundle archive's own checksum;
- a link to [Apply a ROM patch](apply-rom-patches.md#open-a-bundle);
- a place to report problems.

Do not rely on the recipe as the only human explanation. Someone should be able to read the release page and understand what the download changes before opening it.

For an update, rebuild the recipe from the same clean Original and the new patch files. Update the patch details and test the new archive from a fresh page.

## Open a hosted bundle in Apply

You can give users a link that preloads a public bundle:

```text
https://rom-weaver.com/apply?bundle=https://example.com/release.zip
```

The bundle host must permit cross-origin browser downloads with CORS. The user's ROM still stays local. Relative patch URLs inside a remote recipe are resolved against the recipe URL.

The [webapp integration guide](../hosting/webapp-integration.md) covers multiple URL parameters, same-origin files, hosting headers, and error handling. For scripted bundle creation, use the [CLI bundle guide](cli-bundles.md).
