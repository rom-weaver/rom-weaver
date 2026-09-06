# Frequently asked questions

Find the guide that answers your question.

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

[Files and network requests](legal/privacy.md#what-happens-to-your-files).

### Does rom-weaver include games?

[Games, patches, and the supplied homebrew samples](explanation/how-patching-works.md#a-patch-is-not-a-game).

### Will it overwrite my original?

[Browser input preservation and CLI exceptions](explanation/local-first.md#your-original-is-never-modified).

### Can I share the result?

[Bundles and redistribution](explanation/bundles.md#what-it-is-not).

## Applying a patch

### Which page should I use?

[Apply a ROM patch](how-to/apply-rom-patches.md), or [practise with supplied files](tutorials/first-patch.md).

### Which patch format should I choose?

[Choosing a patch format](explanation/patch-formats.md).

### Can I drop a ZIP or 7z without extracting it?

[Add archives in the browser](how-to/apply-rom-patches.md#add-the-files), or [work with archives from the CLI](how-to/work-with-archives.md).

### Why does the expected filename not match?

[Checksums and filenames](explanation/how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not).

### Why does the checksum not match?

Work through [Fix a checksum error](how-to/fix-checksum-errors.md).

### Does patch order matter?

[Why patch order matters](explanation/how-patching-works.md#why-patch-order-matters).

### Why is Apply and Download disabled?

[Check why Apply is unavailable](how-to/apply-rom-patches.md#choose-the-output-and-apply).

## Creating a patch

### What are Original and Modified?

[Original and Modified](how-to/create-rom-patches.md).

### How do I know the patch really works?

[Test the downloaded patch](how-to/create-rom-patches.md#test-the-downloaded-patch).

### What belongs in release notes?

[Write useful release notes](how-to/create-rom-patches.md#write-useful-release-notes).

## Bundles

### What is a bundle?

[What a bundle is](explanation/bundles.md).

### Does a bundle contain the ROM?

[What a bundle contains](explanation/bundles.md#what-it-is-not).

### How do I make one?

[Create and share a patch bundle](how-to/create-bundles.md), or [from the CLI](how-to/cli-bundles.md).

### Can a link open my hosted bundle?

[Open a hosted bundle in Apply](how-to/create-bundles.md#open-a-hosted-bundle-in-apply).

## Devices, browsers, and offline

### Does it work on a phone or tablet?

[Browser memory, storage, and capability limits](explanation/local-first.md#what-this-costs-you).

### Does it work offline?

[Offline requirements](explanation/local-first.md#offline).

### Which browser should I use?

[Browser capabilities and limits](explanation/local-first.md#what-this-costs-you).

### Can I change the theme?

[Change the theme](hosting/webapp-runtime-status.md#theme).

## CLI and support

### Should I use the browser or the CLI?

[Browser and CLI](explanation/browser-and-cli.md) compares them.

### How does rom-weaver compare with the patcher I already use?

[Comparison with similar tools](explanation/comparisons.md).

### How do I install the CLI?

[Install the CLI](how-to/install-cli.md).

### Where can I report a bug?

[Report a problem](../CONTRIBUTING.md#report-a-problem). For vulnerabilities, use the [security policy](../.github/SECURITY.md).

Still looking? The [documentation index](README.md) lists every page.
