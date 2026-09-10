# Icon masters

Source SVGs for the pre-rendered PNGs in `../../src/assets/app/root/`. Each wraps the inner content of `../../src/assets/app/root/logo.svg` in an opaque `#31343a` background rect plus a scale/offset transform - regenerate them from `logo.svg` if the logo changes.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The logo uses a 32 × 32 viewBox. The cartridge fills 30 × 30 units; the disc hub ring is 5.5 units wide, and both bands are 3.8 units wide. The bands interlace - cream over accent at the left crossing, accent over cream at the right - and a charcoal casing stroke opens the gap at each crossing. A 0.75-unit cream outline sits over a 2-unit charcoal outline, keeping the silhouette visible on both dark and light surfaces. The favicon uses this mark directly, without the launcher padding.

The launcher masters center the mark on an opaque charcoal background. The maskable master keeps the mark inside the central 80%-diameter safe circle.

| master | output | scale | offset (x and y) |
| --- | --- | --- | --- |
| icon-maskable.svg | icon-maskable-{192,512}.png | 0.63 | 5.92 |
| apple-touch-icon.svg | apple-touch-icon.png (180px) | 0.80 | 3.2 |

`offset = 16 * (1 - scale)`.

## Rendering

Run from this directory. Inline the SVG so the temporary HTML does not resolve it relative to `/tmp`:

```sh
{ printf '<!doctype html><style>html,body{margin:0}svg{width:100vw;height:100vh}</style>'; cat icon-maskable.svg; } > /tmp/rom-weaver-icon.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --screenshot=icon-maskable-512.png --window-size=512,512 "file:///tmp/rom-weaver-icon.html"
```

Repeat with 192x192 (and 180x180 for apple-touch-icon.svg), then copy the PNGs into `../../src/assets/app/root/`.

Regenerate beta and nightly icons from the repository root with `npm --prefix packages/rom-weaver-webapp run icons:channels`. The script uses the masters in this directory.
