# Icon masters

Source SVGs for the pre-rendered PNGs in `../../packages/rom-weaver-webapp/src/assets/app/root/`. Each wraps the inner content of `../../packages/rom-weaver-webapp/src/assets/app/root/logo.svg` in an opaque `#31343a` background rect plus a scale/offset transform - regenerate them from `logo.svg` if the logo changes.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The logo uses a 32 × 32 viewBox. The cartridge fills 30 × 30 units; the disc hole is 5.5 units wide, and both bands are 5 units wide. A charcoal gap separates the bands at their crossing. A 0.75-unit cream outline sits over a 2-unit charcoal outline, keeping the silhouette visible on both dark and light surfaces. The favicon uses this mark directly, without the launcher padding.

The launcher masters center the mark on an opaque charcoal background. The maskable master keeps the mark inside the central 80%-diameter safe circle.

| master | output | scale | offset (x and y) |
| --- | --- | --- | --- |
| icon-maskable.svg | icon-maskable-{192,512}.png | 0.63 | 5.92 |
| apple-touch-icon.svg | apple-touch-icon.png (180px) | 0.80 | 3.2 |

`offset = 16 * (1 - scale)`.

## Rendering

Headless Chrome gives an exact render (magick's SVG delegate does not):

```sh
printf '<!doctype html><style>html,body{margin:0}</style><img src="icon-maskable.svg" style="display:block;width:512px;height:512px">' > /tmp/i.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --screenshot=icon-maskable-512.png --window-size=512,512 "file:///tmp/i.html"
```

Repeat with 192x192 (and 180x180 for apple-touch-icon.svg), then copy the PNGs into `../../packages/rom-weaver-webapp/src/assets/app/root/`.
