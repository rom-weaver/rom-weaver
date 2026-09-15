# Icon masters

Source SVGs for build-generated icons in `../../../../dist/generated-assets/`. The generator inserts the transparent cartridge SVG from `../../src/assets/app/root/logo.svg` with each channel's default W accent before it rasterizes the master.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The source logo is a 1254 × 1254 transparent SVG. It has cartridge, R, and W paths. The W uses the channel accent in raster icons. The masthead W and SVG favicon change with the selected webapp accent.

| Master | Output | Scale | Offset (x and y) | Background |
| --- | --- | --- | --- | --- |
| icon-maskable.svg | icon-maskable-{192,512}.png | 0.72 | 8.96 | transparent |
| apple-touch-icon.svg | apple-touch-icon.png (180px) | 0.8 | 6.4 | transparent |
| favicon.svg | favicon.ico (16, 32, 48, and 64px frames) | 1 | 0 | transparent |

## Rendering

From the repository root, regenerate production, beta, nightly, and preview icons:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels
```

The generator uses the installed Playwright Chromium browser. It rasterizes each SVG master and stores optimized PNG frames in each ICO. It writes channel icons to the repository `dist/generated-assets/` directory. The build, development server, and script tests run it before they load generated assets. The tracked social preview files in `../../design/` are separate build inputs.

Check the generated output against the current masters:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels:check
```
