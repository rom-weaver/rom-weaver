# Icon masters

Source SVGs for the pre-rendered icons in `../../src/assets/app/root/`. The masters use the Cartridge W paths from `../../src/assets/app/root/logo.svg` with fixed colors and padding for each surface.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The logo uses a 64 × 64 viewBox. The cartridge occupies 48 × 56 units, with a W cutout, a recessed top edge, and three contact cuts at the bottom. The small tab at the top right carries the accent color. The paths contain no fonts, strokes, masks, or clip paths.

The standalone SVG uses charcoal on light surfaces and cream when the browser requests a dark color scheme. The inline webapp mark follows the app's ink and accent CSS tokens. Launcher icons use a cream cartridge on an opaque charcoal background. The ICO favicon adds a charcoal tile so it stays visible without color-scheme support.

| Master | Output | Scale | Offset (x and y) | Background |
| --- | --- | --- | --- | --- |
| icon-maskable.svg | icon-maskable-{192,512}.png | 0.72 | 8.96 | `#31343a` |
| apple-touch-icon.svg | apple-touch-icon.png (180px) | 0.80 | 6.4 | `#31343a` |
| favicon.svg | favicon.ico (16, 32, 48, and 64px frames) | 1 | 0 | `#20282d` tile |

`offset = 32 * (1 - scale)`. The maskable master keeps the mark inside the central 80%-diameter safe circle.

## Rendering

From the repository root, regenerate production, beta, nightly, and preview icons:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels
```

The generator uses the installed Playwright Chromium browser. It renders the PNGs, stores optimized PNG frames in each ICO, and colors each channel's tab from the accent palette. Commit the generated files with the source changes.

Check the generated icons against their sources:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels:check
```
