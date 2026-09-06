# What a bundle is

A rom-weaver bundle records a patch recipe so another user can repeat it.

<!-- START doctoc -->
## Table of contents

- [The problem it solves](#the-problem-it-solves)
- [What it contains](#what-it-contains)
- [What it is not](#what-it-is-not)
- [Why the order lives in the file](#why-the-order-lives-in-the-file)
- [When to make one](#when-to-make-one)
- [Links can carry them](#links-can-carry-them)
- [Related](#related)

<!-- END doctoc -->

## The problem it solves

A multi-patch release asks a lot of its users. They have to obtain the right ROM, keep the patch files apart, run them in the right order, know which ones are optional, and check a set of checksums copied out of a forum post. Every one of those is a place to get it wrong, and getting it wrong produces a file that looks fine until it does not.

A bundle moves that knowledge out of the release notes and into a file the tool can read.

## What it contains

The JSON recipe, conventionally named `rom-weaver-bundle.json`, can record:

- which clean ROM is expected;
- the patch files and their order;
- which patches are required and which are optional;
- patch names, authors, versions, and descriptions;
- expected checksums before and after each step;
- output filename, header policy, and expected checksums. Compression remains the applying user's choice.

An archive can carry the recipe and its patch files together. A recipe can also reference local paths or download URLs.

The machine-readable definition is [`rom-weaver-bundle-v1.schema.json`](../rom-weaver-bundle-v1.schema.json).

## What it is not

**A bundle is not a pre-patched game.** It is a recipe. A patch-only bundle records the expected ROM's checksums without including the ROM bytes. Each user supplies the matching ROM.

A bundle can include ROM bytes, but packaging does not grant redistribution rights.

**A bundle is not release notes.** It tells rom-weaver what to do; it does not tell a person what your patch changes or why they would want it. Both still have to exist.

## Why the order lives in the file

Patch 2 reads patch 1's output, not the original ROM - see [How patching works](how-patching-works.md). The order is therefore part of the release, as load-bearing as the patch files themselves. Recording it in the bundle is what stops a user from reconstructing it by hand out of a numbered filename convention.

The same logic covers the optional patches: "which combinations are supported" is knowledge only the author has, and a bundle can carry it as switches rather than as a paragraph.

## When to make one

Make a bundle when a release has more than one patch, has optional pieces, or expects a specific ROM you want checked automatically.

Skip it for a single patch with no options. One file plus a documented checksum is already simple enough, and a bundle would add a step for no gain.

## Links can carry them

A link can preload a remotely hosted recipe. The browser downloads the recipe and referenced patches, then applies them locally. Cross-origin downloads depend on the host's CORS policy.

[Open a hosted bundle in Apply](../how-to/create-bundles.md#open-a-hosted-bundle-in-apply) gives the link format. [Webapp integration](../hosting/webapp-integration.md) documents the host requirements.

## Related

- [Create and share a patch bundle](../how-to/create-bundles.md) in the browser.
- [Create bundles from the CLI](../how-to/cli-bundles.md) for scripted releases.
- [Choosing a patch format](patch-formats.md) for what goes inside one.
