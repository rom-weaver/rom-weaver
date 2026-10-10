# What a weave is

A rom-weaver weave records a patch recipe so another user can repeat it.

<a id="what-a-bundle-is"></a>

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

Multi-patch releases depend on the right ROM, patch order, options, and checksums. A weave records these requirements in a file rom-weaver can read, preventing missed steps.

## What it contains

The JSON recipe, conventionally named `rom-weaver-weave.json`, can record:

- which clean ROM is expected;
- the patch files and their order;
- which patches are required and which are optional;
- patch names, authors, versions, and descriptions;
- expected checksums before and after each step;
- output filename, header policy, and expected checksums. Compression remains the applying user's choice.

An archive can carry the recipe and its patch files together. A recipe can also reference local paths or download URLs.

Older `rom-weaver-bundle.json` recipes remain readable with the same version 1 and version 2 fields.

The machine-readable definition is [`rom-weaver-weave-v2.schema.json`](../rom-weaver-weave-v2.schema.json).

## What it is not

**A weave is not a pre-patched game.** Patch-only weaves record ROM checksums; users supply matching ROM bytes.

A weave can include ROM bytes, but packaging does not grant redistribution rights.

**A weave is not release notes.** Release notes still explain what the patches change.

## Why the order lives in the file

By default, each patch reads the accumulated result of the selected patches before it. A target can restrict that chain to one ROM member or track. Patches on another track do not change its accumulated result. If an optional patch is disabled, later patches on its target continue from the preceding selected result.

A fixed input has a different contract. A patch that explicitly reads patch A's output keeps that dependency when unrelated patches move or optional choices change. Its producer must be enabled and must run first. Both ROM inputs and generated outputs can select an exact member. A member identifies bytes inside its source; a matching filename in another source is not interchangeable.

For example, A, optional B, and C can form a chain on Track 1 while D modifies Track 2. With B enabled, C reads B's result. With B disabled, C reads A's result. A deliberate dependency on A always reads A, regardless of B's selection. The weave preserves these relationships across saving and reopening.

### Authored checks and execution inputs

The authored basis is the source used to make a patch. Its execution input is what it modifies. Patches can share an authored basis while modifying accumulated results. Their embedded output checksums do not verify the combined result.

Version 2 records a shared authored basis rule, with per-patch exceptions. Automatic inference uses available checks. Version 1 remains readable with its automatic behavior.

The identify database can supply missing checks without changing the recipe. For matched multi-track discs, ROM-based chains inherit their track's checks unless they declare their own. Failures name the declared state's title. See [execution targets](../reference/cli.md#bundle-execution-targets) for the exact rules.

### Shared data and repeated evidence

ROMs, patches, and results can reference one stored check state. The interface displays its evidence wherever needed. Equal digests do not merge separately authored states.

Payloads remain separate from check states. Patches with identical bytes can share one stored file. Selecting a track retains its parent source without duplicating the ROM.

## When to make one

Weaves help releases with several patches, optional pieces, or automatic ROM checks. A single patch without options may only need its file and a documented checksum.

## Links can carry them

A link can preload a remotely hosted recipe. The browser downloads the recipe and referenced patches, then applies them locally. Cross-origin downloads depend on the host's CORS policy.

[Open a hosted weave](../how-to/create-bundles.md#open-a-hosted-bundle-in-apply) gives the link format. [Webapp integration](../hosting/webapp-integration.md) documents the host requirements.

## Related

- [Create and share a patch weave](../how-to/create-bundles.md) in the browser.
- [Create weaves from the CLI](../how-to/cli-bundles.md) for scripted releases.
- [Choosing a patch format](patch-formats.md) for what goes inside one.
