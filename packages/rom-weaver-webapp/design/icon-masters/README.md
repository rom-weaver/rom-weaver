# Icon masters

Source SVGs for build-generated icons in `../../../../dist/generated-assets/`. The generator replaces each logo placeholder with the exact opaque PNG from `../../src/assets/app/root/logo.png` before it rasterizes the master.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The source logo is a 1254 × 1254 opaque PNG. It provides the complete background, cartridge, and RW mark. Channel assets use the same PNG bytes. They do not recolor the W.

| Master | Output | Scale | Offset (x and y) | Background |
| --- | --- | --- | --- | --- |
| icon-maskable.svg | icon-maskable-{192,512}.png | 1 | 0 | source PNG |
| apple-touch-icon.svg | apple-touch-icon.png (180px) | 1 | 0 | source PNG |
| favicon.svg | favicon.ico (16, 32, 48, and 64px frames) | 1 | 0 | source PNG |

## Rendering

From the repository root, regenerate production, beta, nightly, and preview icons:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels
```

The generator uses the installed Playwright Chromium browser. It renders the PNGs and stores optimized PNG frames in each ICO. It writes channel icons to the repository `dist/generated-assets/` directory. The build, development server, and script tests run it before they load generated assets. The tracked social preview files in `../../design/` are separate build inputs.

Check the generated output against the current masters:

```sh
npm --prefix packages/rom-weaver-webapp run icons:channels:check
```
