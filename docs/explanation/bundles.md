# What a bundle is

A rom-weaver bundle records a patch recipe so another user can repeat it.

<!-- START doctoc -->
## Table of contents

- [The problem it solves](#the-problem-it-solves)
- [What it contains](#what-it-contains)
- [What it is not](#what-it-is-not)
- [Why the order lives in the file](#why-the-order-lives-in-the-file)
  - [Authored checks and execution inputs](#authored-checks-and-execution-inputs)
  - [Shared data and repeated evidence](#shared-data-and-repeated-evidence)
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

The machine-readable definition is [`rom-weaver-bundle-v2.schema.json`](../rom-weaver-bundle-v2.schema.json).

## What it is not

**A bundle is not a pre-patched game.** It is a recipe. A patch-only bundle records the expected ROM's checksums without including the ROM bytes. Each user supplies the matching ROM.

A bundle can include ROM bytes, but packaging does not grant redistribution rights.

**A bundle is not release notes.** It tells rom-weaver what to do; it does not tell a person what your patch changes or why they would want it. Both still have to exist.

## Why the order lives in the file

By default, each patch reads the accumulated result of the selected patches before it. A target can restrict that chain to one ROM member or track. Patches on another track do not change its accumulated result. If an optional patch is disabled, later patches on its target continue from the preceding selected result.

A fixed input has a different contract. A patch that explicitly reads patch A's output keeps that dependency when unrelated patches move or optional choices change. Its producer must be enabled and must run first. Both ROM inputs and generated outputs can select an exact member. A member identifies bytes inside its source; a matching filename in another source is not interchangeable.

For example, A, optional B, and C can form a chain on Track 1 while D modifies Track 2. With B enabled, C reads B's result. With B disabled, C reads A's result. A deliberate dependency on A always reads A, regardless of B's selection. The bundle preserves these relationships across saving and reopening.

### Authored checks and execution inputs

The authored basis describes the source against which a patch was made. Its execution input describes the bytes that the operation modifies. Several patches can have the same authored source while modifying an accumulated result. A standalone patch's embedded output checksum does not prove that combined result.

Version 2 records a shared authored basis rule, with per-patch exceptions. Automatic inference uses available checks. Version 1 remains readable with its automatic behavior.

The identify database can stand in for checks a recipe does not declare. When the expected ROM's checks name a multi-track disc record, each track chain that starts from the ROM without checks of its own inherits that track's checks from the record, and a failed check names the title the declared state belongs to. The recipe itself is not changed; the database only adds evidence at apply time. The exact rules are in the [CLI reference](../reference/cli.md#bundle-execution-targets).

### Shared data and repeated evidence

A check state can have several consumers. The recipe stores its values once and uses references from each consumer. The interface can show that same evidence on the ROM, each consuming patch, and a result without copying those values into the recipe. Equal digests alone do not make two separately authored states the same state.

Packaged payloads are separate from check states. Several patch entries can reference one stored file when their payload bytes are equal. Selecting a track retains its parent source instead of adding a second copy of the ROM.

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
