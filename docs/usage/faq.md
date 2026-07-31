# Frequently asked questions

Short answers about browser privacy, ROM matching, patches, bundles, devices,
and the command-line tool.

<!-- START doctoc -->
## Table of contents

- [Files and privacy](#files-and-privacy)
  - [Are my ROMs or patches uploaded?](#are-my-roms-or-patches-uploaded)
  - [Does rom-weaver include games?](#does-rom-weaver-include-games)
  - [Will rom-weaver overwrite my original?](#will-rom-weaver-overwrite-my-original)
  - [Can I share the downloaded result?](#can-i-share-the-downloaded-result)
- [Applying patches](#applying-patches)
  - [Which page should I use?](#which-page-should-i-use)
  - [Which patch format should I choose?](#which-patch-format-should-i-choose)
  - [Can I drop a ZIP or 7z file without extracting it?](#can-i-drop-a-zip-or-7z-file-without-extracting-it)
  - [Why does the expected filename not match?](#why-does-the-expected-filename-not-match)
  - [Why does the checksum not match?](#why-does-the-checksum-not-match)
  - [Does patch order matter?](#does-patch-order-matter)
  - [Why is WEAVE & DOWNLOAD disabled?](#why-is-weave--download-disabled)
- [Creating patches](#creating-patches)
  - [What are Original and Modified?](#what-are-original-and-modified)
  - [How do I know the patch really works?](#how-do-i-know-the-patch-really-works)
  - [What information belongs in release notes?](#what-information-belongs-in-release-notes)
- [Bundles](#bundles)
  - [What is a rom-weaver bundle?](#what-is-a-rom-weaver-bundle)
  - [Does a bundle contain the original ROM?](#does-a-bundle-contain-the-original-rom)
  - [How do I make a bundle?](#how-do-i-make-a-bundle)
  - [Can a link open my hosted bundle?](#can-a-link-open-my-hosted-bundle)
- [Browser, devices, and offline use](#browser-devices-and-offline-use)
  - [Does it work on a phone or tablet?](#does-it-work-on-a-phone-or-tablet)
  - [Does it work offline?](#does-it-work-offline)
  - [Which browser should I use?](#which-browser-should-i-use)
  - [Can I change light and dark theme?](#can-i-change-light-and-dark-theme)
- [CLI and support](#cli-and-support)
  - [Should I use the browser or CLI?](#should-i-use-the-browser-or-cli)
  - [Where can I report a bug?](#where-can-i-report-a-bug)

<!-- END doctoc -->

## Files and privacy

### Are my ROMs or patches uploaded?

No. The webapp reads, checks, patches, compresses, and writes your files on
your device. The hosted site sends the app code and normal web assets to your
browser, but the files you choose are not uploaded to a rom-weaver server.

Large temporary files may be stored in browser-managed local storage while a
job runs. Use **Reset** when you want to clear the current workbench. The
[privacy guide](../legal/privacy.md) explains browser storage, logs, analytics,
and network requests in detail.

### Does rom-weaver include games?

No. rom-weaver is a patching tool. The guided samples are tiny homebrew ROMs
created for the project so anyone can test safely. For a real patch, you
provide your own legally obtained copy of the exact game release the author
documented.

### Will rom-weaver overwrite my original?

No. The browser creates a separate download. Give the result a new name and
keep the clean Original somewhere safe. Updates and other patches may need it
again.

### Can I share the downloaded result?

Usually you should share the patch or a patch-only bundle, not the patched ROM.
A patch contains differences. A public patch-only bundle contains the recipe
and patch files. Whether you may share a ROM depends on the rights you hold.

## Applying patches

### Which page should I use?

Use [Apply](https://rom-weaver.com/apply) when somebody gave you a patch or
bundle. Start [guided Apply](https://rom-weaver.com/apply?guide=apply) for a
safe tour with included files. The complete steps are in
[Apply a ROM patch](apply-rom-patches.md).

### Which patch format should I choose?

When applying, use the patch you were given. Do not convert it just because
another extension looks more familiar. The format is part of the author's
tested release.

When creating, BPS is a good default for cartridge games because it stores
input and output checksums. Use the format expected by the game's community
when compatibility matters. See [Pick a patch format](patch-formats.md).

### Can I drop a ZIP or 7z file without extracting it?

Yes. Weave can inspect supported archives and nested archives. It asks you to
choose when several entries could be the ROM or patch. Create is different:
extract your Original and Modified files before making a patch so archive
packaging does not become part of the comparison.

See the [Formats guide](formats.md) for the core libarchive input list and the
ZIP and 7z output options.

### Why does the expected filename not match?

A filename is advisory. The author may have named the ROM one way while your
dumping tool named the same bytes another way. If the size and checksum match,
the bytes are correct despite the name.

A checksum or expected-size mismatch is strict. Do not confuse that with a
name warning.

### Why does the checksum not match?

The bytes differ. Common causes are the wrong region, wrong revision, a
cartridge header, Nintendo 64 byte order, the wrong entry inside an archive,
an already patched ROM, or patches in the wrong order.

Work through [Fix a checksum error](fix-checksum-errors.md). Do not enable an
override merely to make the warning disappear.

### Does patch order matter?

Yes. Patch 2 receives patch 1's result. Drag the numbered handles into the
order the author documented. If you loaded a bundle, its saved recipe supplies
the order.

### Why is WEAVE & DOWNLOAD disabled?

Wait for every file to finish reading and checksumming. Then check that there
is one usable ROM, at least one enabled patch, no unresolved archive choice,
and no strict validation error. The notice closest to the disabled action
explains what is missing.

## Creating patches

### What are Original and Modified?

Original is the clean, unchanged file users will need. Modified is the finished
file you want them to rebuild. rom-weaver records the differences from
Original to Modified.

If you reverse them, the patch undoes the change. The **Swap** control fixes
the order without making you select both files again.

### How do I know the patch really works?

Test the downloaded patch, not just your Modified file. Open a fresh Weave
page, add a fresh copy of Original and the downloaded patch, create the result,
and compare that result's checksum with Modified. Then launch the rebuilt file.

A matching checksum proves byte-for-byte reconstruction. Launching the file
proves it works in your supported emulator or hardware. Do both.

### What information belongs in release notes?

Include the title, region, revision, header or disc layout, Original checksum
and algorithm, expected output checksum and algorithm, patch format, version,
patch order, optional combinations, changelog, credits, and support link.

For several patches, a bundle records these choices for rom-weaver, but human
release notes should still explain the release.

## Bundles

### What is a rom-weaver bundle?

It is a portable patch recipe. The `rom-weaver-bundle.json` index records the
expected ROM, ordered patches, required or optional choices, checksums,
metadata, and output defaults. An archive can include the patch files beside
that index.

Users drop the bundle into Weave, add their matching ROM if needed, review the
choices, and run it.

### Does a bundle contain the original ROM?

It depends on the package selected by its creator. **Bundle + patches** does
not include the ROM and is the normal choice for a public release.
**Bundle + ROM + patches** includes it and should only be used for homebrew,
public domain files, backups, or material you may redistribute.

### How do I make a bundle?

Start [guided Bundle](https://rom-weaver.com/apply?guide=bundle). It loads the
practice recipe and selects a patch-only ZIP. For a real release, stage the
clean ROM and ordered patches, add patch details, open **Output Options**,
select a bundle package, choose **Create ZIP Bundle**, then download and test
the resulting archive.

The full browser workflow is in
[Create and share a patch bundle](create-bundles.md).

### Can a link open my hosted bundle?

Yes:

```text
https://rom-weaver.com/apply?bundle=https://example.com/release.zip
```

Your file host must allow cross-origin browser requests with CORS. See
[Webapp integration](../hosting/webapp-integration.md) for URL options and
hosting details.

## Browser, devices, and offline use

### Does it work on a phone or tablet?

Yes, within the device's browser, storage, and memory limits. Tap the file
picker instead of dragging. The docs and workbench adapt to a narrow screen.
Large disc images can exceed what a mobile device can process comfortably, so
use a desktop for heavy jobs.

The screenshots in these guides are device-specific. Small screens receive
mobile captures, and the screenshot theme follows the site's light or dark
theme.

### Does it work offline?

The installed webapp can work offline after the browser has visited and cached
the app. Install it from the browser menu when that option is available. Open
the needed route once while online before depending on it offline.

Remote bundle URLs still need a connection to fetch the bundle. Local files
and already cached app code do not.

### Which browser should I use?

Use a current Chromium, Firefox, or Safari release. Browser capabilities vary,
especially for large files, threaded WebAssembly, local storage, and installed
apps. The site detects what is available and reports its runtime status in the
masthead.

If a browser repeatedly runs out of memory on a large disc job, use the CLI,
which is not limited by browser storage and memory rules.

### Can I change light and dark theme?

Yes. Use the theme control in the masthead. The setting persists locally.
Documentation images have separate light and dark captures so labels stay
clear instead of showing a bright screenshot inside a dark page.

## CLI and support

### Should I use the browser or CLI?

Use the browser for visual guidance, one-off jobs, local drag and drop, and the
guided samples. Use the CLI for scripts, batches, CI, repeatable release
commands, and large jobs.

They use the same core patch and container logic, but the interfaces are
different. Browser documentation stays focused on visible controls. The
[CLI usage guide](../hosting/cli.md) owns installation, shell commands, options, and
the command reference.

### Where can I report a bug?

First copy the visible error, app version, browser or CLI version, operating
system, patch format, and the steps that led to it. Do not attach copyrighted
ROMs to a public report. Small legal repro files, such as the included samples,
are ideal.

Use the project's [GitHub issues](https://github.com/rom-weaver/rom-weaver/issues)
for bugs and feature requests. Use the private process in the
[security policy](https://github.com/rom-weaver/rom-weaver/security/policy)
for vulnerabilities.

Still learning? Return to [Browser usage](get-started.md) or choose a guide on
the [documentation home](README.md).
