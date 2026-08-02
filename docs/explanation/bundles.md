# What a bundle is

A rom-weaver bundle is a patch recipe you can hand to someone. This page
explains what problem it solves, what it does and does not contain, and when
it is worth making one.

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

A multi-patch release asks a lot of its users. They have to obtain the right
ROM, keep the patch files apart, run them in the right order, know which ones
are optional, and check a set of checksums copied out of a forum post. Every
one of those is a place to get it wrong, and getting it wrong produces a file
that looks fine until it does not.

A bundle moves that knowledge out of the release notes and into a file the
tool can read.

## What it contains

The required `rom-weaver-bundle.json` index records:

- which clean ROM is expected;
- the patch files and their order;
- which patches are required and which are optional;
- patch names, authors, versions, and descriptions;
- expected checksums before and after each step;
- output filename and format defaults.

The archive around that index can carry the patch files themselves. A user
drops the one archive into Apply, supplies their matching ROM, reviews the
optional choices, and runs it.

The machine-readable definition is
[`rom-weaver-bundle-v1.schema.json`](../rom-weaver-bundle-v1.schema.json).

## What it is not

**A bundle is not a pre-patched game.** It is a recipe. The default package,
*Bundle + patches*, records the expected ROM's checksums but not its bytes, so
a public release can travel without carrying copyrighted data.

There is a *Bundle + ROM + patches* package as well. It exists for homebrew,
public domain material, your own backups, and anything else you hold the
rights to redistribute. A convenient button does not grant permission.

**A bundle is not release notes.** It tells rom-weaver what to do; it does not
tell a person what your patch changes or why they would want it. Both still
have to exist.

## Why the order lives in the file

Patch 2 reads patch 1's output, not the original ROM - see
[How patching works](how-patching-works.md). The order is therefore part of
the release, as load-bearing as the patch files themselves. Recording it in
the bundle is what stops a user from reconstructing it by hand out of a
numbered filename convention.

The same logic covers the optional patches: "which combinations are supported"
is knowledge only the author has, and a bundle can carry it as switches rather
than as a paragraph.

## When to make one

Make a bundle when a release has more than one patch, has optional pieces, or
expects a specific ROM you want checked automatically.

Skip it for a single patch with no options. One file plus a documented
checksum is already simple enough, and a bundle would add a step for no gain.

## Links can carry them

Because the recipe is a file, a URL can preload it:

```text
https://rom-weaver.com/apply?bundle=https://example.com/release.zip
```

The host has to permit cross-origin browser downloads. The user's ROM still
never leaves their device. [Webapp integration](../hosting/webapp-integration.md)
covers the URL parameters and hosting requirements.

## Related

- [Create and share a patch bundle](../how-to/create-bundles.md) in the
  browser.
- [Create bundles from the CLI](../how-to/cli-bundles.md) for scripted
  releases.
- [Choosing a patch format](patch-formats.md) for what goes inside one.
