# Icon masters

Source SVGs for build-generated icons in `../../../../dist/generated-assets/`. The masters use the Cartridge W paths from `../../src/assets/app/root/logo.svg` with fixed colors and padding for each surface.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The cartridge occupies 48 × 56 units, with an accent-colored W, a recessed top edge, and three centered contact cuts at the bottom. The standalone SVG and ICO master use a tight `8 4 48 56` viewBox. They fill the available height without stretching or clipping the cartridge. The inline webapp mark keeps its 64 × 64 viewBox. The top-right corner uses the cartridge color. The paths contain no fonts, strokes, masks, or clip paths.

The standalone SVG uses charcoal on light surfaces and cream when the browser requests a dark color scheme. The inline webapp mark follows the app's ink and accent CSS tokens. Launcher icons use a cream cartridge on an opaque charcoal background. The ICO favicon uses a cream cartridge on a transparent background. The top notch, bottom contact cuts, and rounded corners stay transparent. Square favicon frames have equal transparent margins on the left and right because the cartridge is taller than it is wide.

| Master | Output | Scale | Offset (x and y) | Background |
| --- | --- | --- | --- | --- |
| icon-maskable.svg | icon-maskable-{192,512}.png | 0.72 | 8.96 | `#31343a` |
| apple-touch-icon.svg | apple-touch-icon.png (180px) | 0.80 | 6.4 | `#31343a` |
| favicon.svg | favicon.ico (16, 32, 48, and 64px frames) | Fit cropped viewBox | Centered | Transparent |

For launcher icons, `offset = 32 * (1 - scale)`. The maskable master keeps the mark inside the central 80%-diameter safe circle.

## Rendering

From the repository root, regenerate production, beta, nightly, and preview icons:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels
```

The generator uses the installed Playwright Chromium browser. It renders the PNGs, stores optimized PNG frames in each ICO, and colors each channel's W from the accent palette. It writes channel icons and reusable logo variants to the repository `dist/generated-assets/` directory. The build, development server, and script tests run it before they load generated assets. The tracked social preview files in `../../design/` are separate build inputs.

Check the generated output against the current masters:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels:check
```
