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
- [Create a weave](#create-a-weave)
- [Sample ROMs](#sample-roms)
- [Regenerate the captures](#regenerate-the-captures)
- [Refresh the README video](#refresh-the-readme-video)

<!-- END doctoc -->

## Screenshot inventory

| Subject | Owning guide | What the image explains |
| --- | --- | --- |
| `apply-page` | [README](../../README.md#screenshots) | The whole first Apply screen with two ordered patches |
| `apply-patches` | [Apply patches](../how-to/apply-rom-patches.md#read-the-rom-and-patch-cards) | Patch order, input basis, and checks |
| `apply-output` | [Apply output](../how-to/apply-rom-patches.md#choose-the-output-and-apply) | File name, container, and download action |
| `create-inputs` | [Create a patch](../how-to/create-rom-patches.md) | Original and Modified inputs |
| `create-output` | [Create output](../how-to/create-rom-patches.md) | Patch format and output controls |
| `weave-output` | [Share a weave](../how-to/create-bundles.md#turn-on-bundle-output-and-download-it) | ROM inclusion and the separate sharing action |
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

<a id="create-a-bundle"></a>

## Create a weave

The [weave guide](../how-to/create-bundles.md#turn-on-bundle-output-and-download-it) owns the sharing-control images.

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

The capture script waits for the displayed result and crops the relevant controls. `apply-page` instead keeps the whole first screen, dock included. Desktop uses 2x resolution; mobile uses 3x. Playback is muted.

The crop hides the floating navigation dock so it cannot cover tool controls. ImageMagick crops images and encodes WebP; the bundled WebAssembly encoder creates AVIF.

Keep image paths relative to the Markdown page. The documentation renderer rewrites Markdown images and HTML picture sources for the published site.

After a full capture, the script rewrites each image's `width` and `height` in `README.md` and `docs/` to its measured pixel size. Run `node packages/rom-weaver-webapp/scripts/sync-docs-screenshot-sizes.mjs` after replacing images by hand. Keep alt text and captions specific to the state shown.

The build checks that each subject has every required format, viewport, and theme variant, and that its owning guide references them.

## Refresh the README video

Start the production preview server, then run:

```bash
npm --prefix packages/rom-weaver-webapp run capture:video
```

Install FFmpeg and `bsdtar` first (`ffmpeg` and `libarchive-tools` on Ubuntu). Set `ROM_WEAVER_VIDEO_BASE_URL` when the preview uses a different address. Set `ROM_WEAVER_FFMPEG` when FFmpeg is outside your executable search path. The default preview address is `https://localhost:4173/`.

The capture imports the bundled test archive, applies both patches, and selects 7z. It ends with the download ready, then verifies the downloaded archive's ROM bytes. The MP4 uses H.264, 30 fps, and 1200 × 900 pixels. Output and capture evidence live under `.cache/agents/scratch/release-video/`.

Release dispatch captures this video alongside screenshots on the release PR. It uploads the validated MP4 and replaces the README's `apply-video` marker block. The upload uses `RELEASE_PLEASE_TOKEN`; GitHub attachments require a user token. The installation `GITHUB_TOKEN` cannot upload these attachments. Capture or upload failures stop the refresh before the documentation commit. Re-dispatch creates a new attachment; previous links remain valid.
