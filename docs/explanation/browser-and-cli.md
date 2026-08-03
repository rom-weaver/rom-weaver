# Browser and CLI

rom-weaver ships two front ends over one engine. This page explains what they
share, where they genuinely differ, and how to pick.

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

The patch formats, container handlers, checksum algorithms, and validation
rules live in Rust. The CLI links that code natively. The webapp runs the same
code compiled to WebAssembly, inside your browser's workers.

So a patch created in the browser and a patch created by the CLI are the same
patch. A bundle written by one is read by the other. Moving between them costs
you nothing and changes no file you have already made.

What differs is the interface, and that difference is deliberate.

## What the browser is good at

The browser is the better tool when the answer matters more than the
repetition:

- **It explains what it found.** Cards show checksums, expected names, header
  state, and archive contents before you commit to anything.
- **It needs no install.** Open a URL and work.
- **It has guided samples.** You can learn the workflow on homebrew files
  before touching a real ROM.
- **It works on phones and tablets**, within their memory limits.

Use it when you are learning, patching a handful of files, or want the
warnings to tell you why something is wrong.

## What the CLI is good at

The CLI is the better tool when the work repeats or the files are large:

- **It scripts.** Batch jobs, CI, and release automation need commands, not
  clicks.
- **It is not inside a browser sandbox.** Large disc images are limited by your
  machine, not by a tab's storage and memory rules.
- **Its flags are quotable.** A release note can carry the exact command
  readers should run.
- **It emits JSON.** Other tools can consume its output.

Use it for scripts, batches, CI, repeatable release commands, and heavy jobs.

## Why the documentation does not mix them

Browser guides do not put terminal commands in the middle of a visual
workflow, and CLI guides do not describe cards and drag handles. A reader
following one interface should never have to translate steps written for the
other.

That is why installation, terminal examples, and flags live in the CLI pages
and the [CLI reference](../reference/cli.md), while the browser guides stay on
visible controls.

## If you are unsure

Start in the browser. It is the fastest way to understand what a patch job
involves, and nothing you produce there has to be redone if you later move to
the CLI.

Move to the CLI when you notice yourself doing the same thing a third time, or
when a browser tab runs out of room on a large disc image.

## Related

- [Your first patch in the browser](../tutorials/first-patch.md)
- [Your first apply in the terminal](../tutorials/cli-first-weave.md)
- [Why your files stay on your device](local-first.md)
