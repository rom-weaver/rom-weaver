# Icon masters

`brand-mark.svg` is the only editable source for the brand geometry. It contains the two brand paths on a transparent canvas and uses `currentColor` only. It has no accent palette, theme colors, or background. The checked-in files under `renders/` are generated views of this master.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The cartridge occupies 48 × 56 units, with a recessed top edge and three centered contact cuts at the bottom. The W is a separate path so the build can apply every accent color. The master keeps a `0 0 64 64` viewBox for the inline webapp mark. Standalone logos use the tight `8 4 48 56` viewBox. The paths contain no fonts, strokes, masks, or clip paths.

`renderBrandMark` applies the light cartridge (`#20282d`) or dark cartridge (`#f6ecda`) and one accent swatch. Responsive SVGs select the cartridge with `prefers-color-scheme`; explicit light and dark renders keep the same transparent background. The inline webapp mark follows the app's ink and accent CSS tokens.

| Render | Output | Scale | Offset (x and y) | Background |
| --- | --- | --- | --- | --- |
| Responsive tight render | `renders/*.svg`; `channel-icons/*/logo.svg`, `logo-variants/*.svg` | — | — | Transparent |
| Explicit light render | `renders/light/*.svg`; `logo-variants/light/*.svg` | — | — | Transparent |
| Explicit dark render | `renders/dark/*.svg`; `logo-variants/dark/*.svg` | — | — | Transparent |
| Explicit dark render in launcher wrapper | `icon-maskable-{192,512}.png` | 0.72 | 8.96 | `#31343a` |
| Explicit dark render in launcher wrapper | `apple-touch-icon.png` (180px) | 0.80 | 6.4 | `#31343a` |
| Explicit dark tight render | `favicon.ico` (16, 32, 48, and 64px frames) | Fit tight viewBox | Centered | Transparent |

For launcher icons, `offset = 32 * (1 - scale)`. The generated maskable version keeps the mark inside the central safe circle. Its opaque background is added by the build wrapper, not by the canonical master.

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

The icon generator uses the installed Playwright Chromium browser. It renders the PNGs, stores optimized PNG frames in each ICO, and colors each channel's W from the accent palette. It writes channel icons and reusable light/dark logo variants to the ignored `dist/generated-assets/` directory. The build and checks fail when the checked-in SVG renders are stale.

The accent palette is defined once in `../../src/webapp/accent-palette.mjs`. `npm --prefix packages/rom-weaver-webapp run accents:generate` writes the CSS token blocks from that palette, and `npm --prefix packages/rom-weaver-webapp run accents:check` fails when the generated CSS is stale.

Check the generated output against the current masters:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels:check
```
