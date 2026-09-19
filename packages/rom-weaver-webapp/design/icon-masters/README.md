# Icon masters

`brand-mark.svg` is the only editable source for the brand geometry. It contains the two brand paths on a transparent canvas and uses `currentColor` only. It has no accent palette, tone colors, or background. The checked-in files under `renders/` are generated views of this master.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The cartridge occupies 48 × 56 units, with a recessed top edge and three centered contact cuts at the bottom. The W is a separate path so the build can apply every accent color. The master keeps a `0 0 64 64` viewBox for the inline webapp mark. Standalone logos use the tight `8 4 48 56` viewBox. The paths contain no fonts, strokes, masks, or clip paths.

`renderBrandMark` applies a dark logo tone (`#20282d`) or light logo tone (`#f6ecda`) and one accent swatch. Generated responsive SVGs select the tone with `prefers-color-scheme`; explicit light and dark renders keep the same transparent background. The inline webapp mark follows the app's ink and accent CSS tokens.

| Render | Output | Scale | Offset (x and y) | Background |
| --- | --- | --- | --- | --- |
| Responsive generated render | `channel-icons/*/logo.svg`, `logo-variants/*.svg` | — | — | Transparent |
| Dark logo render | `renders/dark/*.svg`; `logo-variants/dark/*.svg` | — | — | Transparent |
| Light logo render | `renders/light/*.svg`; `logo-variants/light/*.svg` | — | — | Transparent |
| Adaptive favicon | `channel-icons/*/favicon.svg` | Aspect preserved | 5% vertical, 11.4% horizontal | Transparent |
| Light logo app render | `icon-{192,512}.png` | 0.9 | Centered | `#31343a` |
| Light logo maskable render | `icon-maskable-512.png` | 0.72 | Central mask-safe region | `#31343a` |
| Light logo app render | `apple-touch-icon.png` (180px) | 0.9 | Centered inside the iOS mask safe area | `#31343a` |
| Light logo favicon fallback | `favicon-32x32.png`; `favicon.ico` (16, 32, 48, and 64px frames) | 1.02 | 5–12% | `#31343a` |

For app, maskable, touch, and fallback icons, `offset = 32 * (1 - scale)`. The dedicated maskable version keeps the mark inside the central safe region. Each app icon has a full-canvas opaque background and no pre-rounded corners. The touch icon has enough space for the iOS mask.

## Rendering

From the repository root, render the checked-in SVG views:

```sh
npm --prefix packages/rom-weaver-webapp run brand:render
```

Check those views:

```sh
npm --prefix packages/rom-weaver-webapp run brand:check
```

Then regenerate production, beta, nightly, and preview icons:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels
```

The icon generator uses the installed Playwright Chromium browser. It renders the PNGs, stores optimized PNG frames in the fixed-tone ICO fallback, and colors each channel's W from the accent palette. It writes channel icons, one adaptive favicon SVG per channel, and responsive and explicit light/dark logo variants to the ignored `dist/generated-assets/` directory. The build and checks fail when the checked-in SVG renders are stale.

The webapp links one adaptive `favicon.svg`. Its internal media query selects the cartridge tone from the browser chrome color scheme, including in Firefox, which ignores media queries on favicon links. The undistorted SVG keeps 5–12% padding around the mark. The opaque 32px PNG and multi-size ICO fallbacks keep the light logo on the loom chassis color, so recognition does not depend on browser theme adaptation.

The accent palette is defined once in `../../src/webapp/accent-palette.mjs`. `npm --prefix packages/rom-weaver-webapp run accents:generate` writes the CSS token blocks from that palette, and `npm --prefix packages/rom-weaver-webapp run accents:check` fails when the generated CSS is stale.

Check the generated output against the current masters:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels:check
```
