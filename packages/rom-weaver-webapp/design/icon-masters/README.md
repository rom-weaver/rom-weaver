# Icon masters

Source SVGs for the pre-rendered PNGs in `../../src/assets/app/root/`. Each wraps the inner content of `../../src/assets/app/root/logo.svg` in an opaque `#31343a` background rect plus a scale/offset transform - regenerate them from `logo.svg` if the logo changes.

<!-- START doctoc -->
## Table of contents

- [Geometry](#geometry)
- [Rendering](#rendering)

<!-- END doctoc -->

## Geometry

The logo uses a 32 × 32 viewBox. It is not drawn by hand: `scripts/trace-logo.mjs` traces `design/logo-concepts/thread-weave.png` with potrace, one layer per brand colour, and writes both `logo.svg` and `brand-mark.tsx`. Pixels are snapped to the palette first, so the accent layer is a single `#d9690f` fill that `tintBrandMark` re-dyes and `--thread` overrides. Cream touching the image border is flood-filled away, so the mark stays transparent outside the cartridge. Re-run the script after changing the reference render; `--check` fails when the two outputs drift from it. The hub ring only resolves above roughly 64 px, so it reads as a grey smudge in the 30 px masthead and the 16 px favicon.

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
