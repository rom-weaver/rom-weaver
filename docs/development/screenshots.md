# Screenshots and sample assets

The documentation uses focused captures of real sample workflows. Each subject
has desktop and mobile images in both light and dark themes.

<!-- START doctoc -->
## Table of contents

- [Apply patches](#apply-patches)
  - [Ordered patch stack](#ordered-patch-stack)
  - [Weave output](#weave-output)
- [Create a patch](#create-a-patch)
  - [Original and Modified](#original-and-modified)
  - [Patch output](#patch-output)
- [Create a bundle](#create-a-bundle)
- [Sample ROMs](#sample-roms)
- [Regenerate the captures](#regenerate-the-captures)

<!-- END doctoc -->

## Apply patches

### Ordered patch stack

<picture>
  <source media="(prefers-color-scheme: dark)" type="image/avif" srcset="../../packages/rom-weaver-webapp/design/apply-patches-desktop-dark.avif">
  <source type="image/avif" srcset="../../packages/rom-weaver-webapp/design/apply-patches-desktop-light.avif">
  <source media="(prefers-color-scheme: dark)" type="image/webp" srcset="../../packages/rom-weaver-webapp/design/apply-patches-desktop-dark.webp">
  <img src="../../packages/rom-weaver-webapp/design/apply-patches-desktop-light.webp" width="2242" height="1045" alt="Focused Weave patch stack with two ordered practice patches on desktop">
</picture>

### Weave output

<picture>
  <source media="(prefers-color-scheme: dark)" type="image/avif" srcset="../../packages/rom-weaver-webapp/design/apply-output-desktop-dark.avif">
  <source type="image/avif" srcset="../../packages/rom-weaver-webapp/design/apply-output-desktop-light.avif">
  <source media="(prefers-color-scheme: dark)" type="image/webp" srcset="../../packages/rom-weaver-webapp/design/apply-output-desktop-dark.webp">
  <img src="../../packages/rom-weaver-webapp/design/apply-output-desktop-light.webp" width="2242" height="560" alt="Focused Weave output card on desktop">
</picture>

Mobile versions:
[patch stack](../../packages/rom-weaver-webapp/design/apply-patches-mobile-light.webp)
and [Weave output](../../packages/rom-weaver-webapp/design/apply-output-mobile-light.webp).
The web guide selects these automatically on narrow screens and switches to
their dark variants with the site theme.

## Create a patch

### Original and Modified

<picture>
  <source media="(prefers-color-scheme: dark)" type="image/avif" srcset="../../packages/rom-weaver-webapp/design/create-inputs-desktop-dark.avif">
  <source type="image/avif" srcset="../../packages/rom-weaver-webapp/design/create-inputs-desktop-light.avif">
  <source media="(prefers-color-scheme: dark)" type="image/webp" srcset="../../packages/rom-weaver-webapp/design/create-inputs-desktop-dark.webp">
  <img src="../../packages/rom-weaver-webapp/design/create-inputs-desktop-light.webp" width="2242" height="837" alt="Focused Create Original and Modified cards on desktop">
</picture>

### Patch output

<picture>
  <source media="(prefers-color-scheme: dark)" type="image/avif" srcset="../../packages/rom-weaver-webapp/design/create-output-desktop-dark.avif">
  <source type="image/avif" srcset="../../packages/rom-weaver-webapp/design/create-output-desktop-light.avif">
  <source media="(prefers-color-scheme: dark)" type="image/webp" srcset="../../packages/rom-weaver-webapp/design/create-output-desktop-dark.webp">
  <img src="../../packages/rom-weaver-webapp/design/create-output-desktop-light.webp" width="2242" height="568" alt="Focused Create patch output card on desktop">
</picture>

Mobile versions:
[Original and Modified](../../packages/rom-weaver-webapp/design/create-inputs-mobile-light.webp)
and [patch output](../../packages/rom-weaver-webapp/design/create-output-mobile-light.webp).

## Create a bundle

<picture>
  <source media="(prefers-color-scheme: dark)" type="image/avif" srcset="../../packages/rom-weaver-webapp/design/bundle-output-desktop-dark.avif">
  <source type="image/avif" srcset="../../packages/rom-weaver-webapp/design/bundle-output-desktop-light.avif">
  <source media="(prefers-color-scheme: dark)" type="image/webp" srcset="../../packages/rom-weaver-webapp/design/bundle-output-desktop-dark.webp">
  <img src="../../packages/rom-weaver-webapp/design/bundle-output-desktop-light.webp" width="2242" height="796" alt="Focused patch-only bundle options and Create ZIP Bundle action on desktop">
</picture>

The [mobile capture](../../packages/rom-weaver-webapp/design/bundle-output-mobile-light.webp)
keeps the entire expanded Output Options card readable.

## Sample ROMs

| Original ROM | After the first patch | After both patches |
| :---: | :---: | :---: |
| ![The original sample ROM displaying HELLO WORLD in an NES emulator](../../packages/rom-weaver-webapp/design/first-sample-hello-world.webp) | ![The sample ROM displaying MODIFIED WORLD after the first patch](../../packages/rom-weaver-webapp/design/first-sample-modified-world.webp) | ![The sample ROM displaying MODIFIED ROM after both patches](../../packages/rom-weaver-webapp/design/first-sample-modified-rom.webp) |

The webapp generates `first-weave.zip`, `first-create.zip`, and the loose
homebrew ROMs from
[`first-sample-assets.mjs`](../../packages/rom-weaver-webapp/scripts/first-sample-assets.mjs).
The guided tours and automated tests use the same assets.

## Regenerate the captures

Build and serve the production webapp, then run:

```bash
ROM_WEAVER_SCREENSHOT_BASE_URL=http://127.0.0.1:4173/ \
  npm --prefix packages/rom-weaver-webapp run capture:screenshots
```

The capture script opens the generated samples, waits for reading and checksum
work to settle, and crops to the controls each guide explains. It renders
desktop at 2x and mobile at 3x, then saves AVIF images with lossless WebP
fallbacks.

To regenerate one subject while adjusting its crop:

```bash
ROM_WEAVER_SCREENSHOT_BASE_URL=http://127.0.0.1:4173/ \
ROM_WEAVER_SCREENSHOT_CASE=bundle-output \
  npm --prefix packages/rom-weaver-webapp run capture:screenshots
```

The build verifies that every documented device and theme variant exists and
is referenced by its guide.
