# Browser and CLI

rom-weaver ships two front ends over one engine. Both use the same patch and container implementations.

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

The patch formats, container handlers, checksum algorithms, and validation rules live in Rust. The CLI links that code natively. The webapp runs the same code compiled to WebAssembly, inside your browser's workers.

Patches and bundles created by either interface can be read by the other. Output bytes can depend on the selected format, options, and backend; sharing the engine does not guarantee identical compressed files.

What differs is the interface, and that difference is deliberate.

## What the browser is good at

The browser presents file details and workflow choices together:

- **It explains what it found.** Cards show checksums, expected names, header state, and archive contents before you commit to anything.
- **It needs no install.** The app runs from a web address.
- **It has guided samples.** You can learn the workflow on homebrew files before touching a real ROM.
- **It works on phones and tablets**, within their memory limits.

These properties suit learning and occasional patching, where visible checks help explain a mismatch.

## What the CLI is good at

The CLI is the better tool when the work repeats or the files are large:

- **It scripts.** Batch jobs, CI, and release automation need commands, not clicks.
- **It is not inside a browser sandbox.** Large disc images are limited by your machine, not by a tab's storage and memory rules.
- **Its flags are quotable.** A release note can carry the exact command readers should run.
- **It emits JSON.** Other tools can consume its output.

These properties suit scripts, batches, CI, repeatable release commands, and large jobs.

## Why the documentation does not mix them

Browser guides do not put terminal commands in the middle of a visual workflow, and CLI guides do not describe cards and drag handles. A reader following one interface should never have to translate steps written for the other.

That is why installation, terminal examples, and flags live in the CLI pages and the [CLI reference](../reference/cli.md), while the browser guides stay on visible controls.

## If you are unsure

The browser lowers the setup cost of a first job. The CLI lowers the repetition cost of later jobs and avoids browser storage limits.

The [feature map](../reference/features.md) distinguishes shared capabilities from browser-only playback and interface-specific controls.

## Related

- [Your first patch in the browser](../tutorials/first-patch.md)
- [Your first apply in the terminal](../tutorials/cli-first-weave.md)
- [Why your files stay on your device](local-first.md)
