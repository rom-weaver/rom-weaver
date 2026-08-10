# Frequently asked questions

Every answer lives on the page that owns the topic, so it stays correct when that page changes. This list is a map to those pages, grouped by what you are trying to find out.

<!-- START doctoc -->
## Table of contents

- [Files and privacy](#files-and-privacy)
  - [Are my ROMs or patches uploaded?](#are-my-roms-or-patches-uploaded)
  - [Does rom-weaver include games?](#does-rom-weaver-include-games)
  - [Will it overwrite my original?](#will-it-overwrite-my-original)
  - [Can I share the result?](#can-i-share-the-result)
- [Applying a patch](#applying-a-patch)
  - [Which page should I use?](#which-page-should-i-use)
  - [Which patch format should I choose?](#which-patch-format-should-i-choose)
  - [Can I drop a ZIP or 7z without extracting it?](#can-i-drop-a-zip-or-7z-without-extracting-it)
  - [Why does the expected filename not match?](#why-does-the-expected-filename-not-match)
  - [Why does the checksum not match?](#why-does-the-checksum-not-match)
  - [Does patch order matter?](#does-patch-order-matter)
  - [Why is Apply and Download disabled?](#why-is-apply-and-download-disabled)
- [Creating a patch](#creating-a-patch)
  - [What are Original and Modified?](#what-are-original-and-modified)
  - [How do I know the patch really works?](#how-do-i-know-the-patch-really-works)
  - [What belongs in release notes?](#what-belongs-in-release-notes)
- [Bundles](#bundles)
  - [What is a bundle?](#what-is-a-bundle)
  - [Does a bundle contain the ROM?](#does-a-bundle-contain-the-rom)
  - [How do I make one?](#how-do-i-make-one)
  - [Can a link open my hosted bundle?](#can-a-link-open-my-hosted-bundle)
- [Devices, browsers, and offline](#devices-browsers-and-offline)
  - [Does it work on a phone or tablet?](#does-it-work-on-a-phone-or-tablet)
  - [Does it work offline?](#does-it-work-offline)
  - [Which browser should I use?](#which-browser-should-i-use)
  - [Can I change the theme?](#can-i-change-the-theme)
- [CLI and support](#cli-and-support)
  - [Should I use the browser or the CLI?](#should-i-use-the-browser-or-the-cli)
  - [How does rom-weaver compare with the patcher I already use?](#how-does-rom-weaver-compare-with-the-patcher-i-already-use)
  - [How do I install the CLI?](#how-do-i-install-the-cli)
  - [Where can I report a bug?](#where-can-i-report-a-bug)

<!-- END doctoc -->

## Files and privacy

### Are my ROMs or patches uploaded?

No. [Why your files stay on your device](explanation/local-first.md) explains how that is enforced, and [Privacy](legal/privacy.md) has the detailed statement.

### Does rom-weaver include games?

No. It is a patching tool, and the guided samples are homebrew ROMs written for this project. See [How patching works](explanation/how-patching-works.md#a-patch-is-not-a-game).

### Will it overwrite my original?

No. rom-weaver always writes a new file - [your original is never modified](explanation/local-first.md#your-original-is-never-modified).

### Can I share the result?

Usually you should share the patch or a patch-only bundle, not the patched ROM. See [what a bundle is not](explanation/bundles.md#what-it-is-not).

## Applying a patch

### Which page should I use?

[Apply](https://rom-weaver.com/apply), following [Apply a ROM patch](how-to/apply-rom-patches.md). If you have never done it, start with [your first patch](tutorials/first-patch.md).

### Which patch format should I choose?

When applying, use the one you were given. When publishing, see [Choosing a patch format](explanation/patch-formats.md).

### Can I drop a ZIP or 7z without extracting it?

Yes, including nested archives - [Apply a ROM patch](how-to/apply-rom-patches.md) covers it in the browser, and [Work with archives](how-to/work-with-archives.md) has the terminal recipes.

### Why does the expected filename not match?

A name is advisory; bytes are not. See [what a checksum proves](explanation/how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not).

### Why does the checksum not match?

Work through [Fix a checksum error](how-to/fix-checksum-errors.md).

### Does patch order matter?

Yes - [why patch order matters](explanation/how-patching-works.md#why-patch-order-matters).

### Why is Apply and Download disabled?

Something is still reading, or a check has not passed. See [choose the output and apply](how-to/apply-rom-patches.md#choose-the-output-and-apply).

## Creating a patch

### What are Original and Modified?

[Create a ROM patch](how-to/create-rom-patches.md) opens with the distinction, and the direction matters.

### How do I know the patch really works?

Test the downloaded patch, not your Modified file - [test the downloaded patch](how-to/create-rom-patches.md#test-the-downloaded-patch).

### What belongs in release notes?

[Write useful release notes](how-to/create-rom-patches.md#write-useful-release-notes).

## Bundles

### What is a bundle?

A portable patch recipe - [What a bundle is](explanation/bundles.md).

### Does a bundle contain the ROM?

Not by default - [what it is not](explanation/bundles.md#what-it-is-not).

### How do I make one?

[Create and share a patch bundle](how-to/create-bundles.md), or [from the CLI](how-to/cli-bundles.md).

### Can a link open my hosted bundle?

Yes, with CORS - [links can carry them](explanation/bundles.md#links-can-carry-them) and [Webapp integration](hosting/webapp-integration.md).

## Devices, browsers, and offline

### Does it work on a phone or tablet?

Yes, within the device's limits - [what this costs you](explanation/local-first.md#what-this-costs-you).

### Does it work offline?

After the browser has cached the app - [offline](explanation/local-first.md#offline).

### Which browser should I use?

A current Chromium, Firefox, or Safari; the masthead reports what it found - [Webapp runtime status](hosting/webapp-runtime-status.md).

### Can I change the theme?

Yes, from the masthead control. Documentation screenshots follow it.

## CLI and support

### Should I use the browser or the CLI?

[Browser and CLI](explanation/browser-and-cli.md) compares them.

### How does rom-weaver compare with the patcher I already use?

[Comparison with similar tools](explanation/comparisons.md) puts it beside RomPatcher.js, Flips, MultiPatch, xdelta3, chdman, and Dolphin tool.

### How do I install the CLI?

[Install the CLI](how-to/install-cli.md).

### Where can I report a bug?

[GitHub issues](https://github.com/rom-weaver/rom-weaver/issues), with the visible error, versions, and steps that led to it. Never attach copyrighted ROMs; the homebrew samples make ideal repro files. Report vulnerabilities privately through the [security policy](https://github.com/rom-weaver/rom-weaver/security/policy).

Still looking? The [documentation index](README.md) lists every page.
