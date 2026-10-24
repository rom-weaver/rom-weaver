# Browser and CLI

rom-weaver's browser and CLI share one engine.

<!-- START doctoc -->
## Table of contents

- [One engine, two front ends](#one-engine-two-front-ends)
- [What the browser is good at](#what-the-browser-is-good-at)
- [What the CLI is good at](#what-the-cli-is-good-at)
- [Why the documentation does not mix them](#why-the-documentation-does-not-mix-them)
- [If you are unsure](#if-you-are-unsure)
- [Related](#related)

<!-- END doctoc -->

## One engine, two front ends

Rust implements patches, containers, checksums, and validation. The CLI links it natively; the webapp runs it as WebAssembly in browser workers.

Both interfaces read each other's patches and weaves. Format, options, and backend can change output bytes, so compressed files may differ.

## What the browser is good at

The browser combines file details and workflow choices:

- **It explains files.** Cards show checksums, expected names, headers, and archive contents before processing.
- **It needs no install.** The app runs from a web address.
- **It has guided samples.** Learn with homebrew files before using a real ROM; see [Guided practice runs](../reference/guided-runs.md).
- **It works on phones and tablets**, within their memory limits.

## What the CLI is good at

The CLI suits repeated work and large files:

- **It scripts.** Commands support batches, CI, and releases.
- **It avoids browser limits.** Your machine bounds large disc jobs, rather than a tab's storage and memory rules.
- **Its flags are quotable.** Release notes can include exact commands.
- **It emits JSON** for other tools.

## Why the documentation does not mix them

Browser guides describe visible controls; CLI guides describe commands. Neither requires translating steps from the other interface.

Installation, terminal examples, and flags belong in CLI pages and the [CLI reference](../reference/cli.md).

## If you are unsure

The browser reduces initial setup; the CLI reduces repetition and avoids browser storage limits.

The [feature map](../reference/features.md) separates shared capabilities, browser playback, and interface-specific controls.

## Related

- [Your first patch in the browser](../tutorials/first-patch.md)
- [Your first apply in the terminal](../tutorials/cli-first-weave.md)
- [Why your files stay on your device](local-first.md)
