# Screenshots and sample assets

Documentation images show real app controls with homebrew samples or a generated save. The committed files live in `docs/screenshots/`.

<!-- START doctoc -->
## Table of contents

- [Screenshot inventory](#screenshot-inventory)
- [Apply patches](#apply-patches)
  - [Ordered patch stack](#ordered-patch-stack)
  - [Apply output](#apply-output)
- [Create a patch](#create-a-patch)
  - [Original and Modified](#original-and-modified)
  - [Patch output](#patch-output)
- [Create a bundle](#create-a-bundle)
- [Sample ROMs](#sample-roms)
- [Regenerate the captures](#regenerate-the-captures)

<!-- END doctoc -->

## Screenshot inventory

| Subject | Owning guide | What the image explains |
| --- | --- | --- |
| `apply-patches` | [Apply patches](../how-to/apply-rom-patches.md#read-the-rom-and-patch-cards) | Patch order, input basis, and checks |
| `apply-output` | [Apply output](../how-to/apply-rom-patches.md#choose-the-output-and-apply) | File name, container, and download action |
| `create-inputs` | [Create a patch](../how-to/create-rom-patches.md) | Original and Modified inputs |
| `create-output` | [Create output](../how-to/create-rom-patches.md) | Patch format and output controls |
| `bundle-output` | [Share a bundle](../how-to/create-bundles.md#turn-on-bundle-output-and-download-it) | ROM inclusion and the separate sharing action |
| `identify-checks` | [Identify a ROM](../how-to/identify-roms-browser.md) | An unknown homebrew ROM with usable checksums |
| `cheat-step` | [Use cheats](../how-to/use-browser-cheats.md) | A manual ROM-write step in the patch order |
| `save-editor` | [Edit a save](../how-to/edit-gen3-saves.md) | Filtered fields and a checked edit preview |
| `test-player` | [Test a ROM](../how-to/test-roms-in-browser.md) | The homebrew player and its ROM fingerprint |

Each subject has desktop and mobile captures in light and dark themes. AVIF is the preferred image format; WebP is the fallback. These are delivery variants, not duplicate examples.

The manual cheat capture demonstrates the controls, not a useful cheat for the homebrew ROM. The save capture changes a generated Zelda save; it includes no game ROM.

## Apply patches

### Ordered patch stack

The [Apply guide](../how-to/apply-rom-patches.md#read-the-rom-and-patch-cards) owns the patch-stack images.

### Apply output

The [output section](../how-to/apply-rom-patches.md#choose-the-output-and-apply) owns the output images. Conversion uses the same controls, so its guide links here.

## Create a patch

### Original and Modified

The [Create guide](../how-to/create-rom-patches.md) owns both input and output captures.

### Patch output

The output capture shows format selection. It does not show a second workflow.

## Create a bundle

The [bundle guide](../how-to/create-bundles.md#turn-on-bundle-output-and-download-it) owns the sharing-control images.

## Sample ROMs

The three `first-sample-*.webp` images show `HELLO WORLD`, `ROM WORLD`, and `ROM WEAVER`. The [first-patch tutorial](../tutorials/first-patch.md) uses the before-and-after pair.

The app generates its homebrew ROMs and sample archives from [first-sample-assets.mjs](../../packages/rom-weaver-webapp/scripts/first-sample-assets.mjs). Tours, tests, and captures use these same bytes.

## Regenerate the captures

Build and serve the production webapp as described in [Development](development.md). From the repository root, set the preview URL:

```sh
export ROM_WEAVER_SCREENSHOT_BASE_URL=https://192.168.1.10:45443/
```

Replace the example address and port with your preview server's address and port. Then capture all subjects:

```sh
npm --prefix packages/rom-weaver-webapp run capture:screenshots
```

To capture one subject, set its inventory name first:

```sh
export ROM_WEAVER_SCREENSHOT_CASE=save-editor
```

Clear that filter before the next full capture:

```sh
unset ROM_WEAVER_SCREENSHOT_CASE
```

The capture script waits for the displayed result and crops the relevant controls. Desktop uses 2x resolution; mobile uses 3x. Playback is muted.

The crop hides the floating navigation dock so it cannot cover tool controls. ImageMagick crops images and encodes WebP; the bundled WebAssembly encoder creates AVIF.

Keep image paths relative to the Markdown page. The documentation renderer rewrites Markdown images and HTML picture sources for the published site.

After regeneration, update each image's `width` and `height` to its measured pixel size. Keep alt text and captions specific to the state shown.

The build checks that each subject has every required format, viewport, and theme variant, and that its owning guide references them.
