# ROM patcher comparisons: rom-weaver, RomPatcher.js and other tools

The right ROM patcher depends on the job: one patch, an embedded patcher, or a complete workflow. This comparison covers RomPatcher.js, Flips, MultiPatch, and specialist disc converters. Format counts alone do not establish which tool fits your files.

<a id="comparison-with-similar-tools"></a>

<!-- START doctoc -->
## Table of contents

- [The tools](#the-tools)
- [At a glance](#at-a-glance)
- [Applying a patch](#applying-a-patch)
- [rom-weaver as a RomPatcher.js alternative](#rom-weaver-as-a-rompatcherjs-alternative)
- [Creating a patch](#creating-a-patch)
- [Containers and disc images](#containers-and-disc-images)
- [Native conversion speed against chdman and dolphin-tool](#native-conversion-speed-against-chdman-and-dolphin-tool)
- [Checksums](#checksums)
- [Headers and byte order](#headers-and-byte-order)
- [Patching features](#patching-features)
- [Beyond patching](#beyond-patching)
- [Delivery and platforms](#delivery-and-platforms)
- [Which one should you use?](#which-one-should-you-use)
- [How this page was checked](#how-this-page-was-checked)

<!-- END doctoc -->

## The tools

| Tool | Main purpose | Trade-off |
| --- | --- | --- |
| rom-weaver | Extraction, patch chains, checksums, compression, and weaves in a browser or native CLI | More controls than a single-purpose patcher; browser storage limits still apply. |
| [RomPatcher.js](https://github.com/marcrobledo/RomPatcher.js) | Browser and Node patching, including embedding in another website | A useful fit for a release page with its own patch button. |
| [Floating IPS (Flips)](https://github.com/Sir-Walrus/Flips) | IPS and BPS patch creation and application | A focused alternative when those formats cover the job. |
| [MultiPatch](https://github.com/Sappharad/MultiPatch) | A native macOS app for several patch families | Fits a desktop macOS workflow rather than a browser workflow. |
| [xdelta3](https://github.com/jmacd/xdelta) | General binary differences using VCDIFF | Works beyond ROMs; it does not choose a ROM's header or byte order. |
| [chdman](https://docs.mamedev.org/tools/chdman.html) | CHD creation, extraction, and verification | Provides the reference CHD tooling, including operations outside rom-weaver's CLI surface. |
| [Dolphin tool](https://github.com/dolphin-emu/dolphin/blob/master/Source/Core/DolphinTool/ConvertCommand.cpp) | GameCube and Wii disc conversion | Includes GCZ and WIA output, which rom-weaver does not create. |

<a id="legend"></a>

## At a glance

An existing patch usually decides the format for you. The remaining choices concern the interface, input preparation, and checks. [Supported formats](../reference/formats.md) owns rom-weaver's capability tables; each linked project documents its own support.

## Applying a patch

For a single uncompressed ROM and a supported patch, a focused patcher can be sufficient. rom-weaver becomes useful when the input needs extraction, several patches must run in order, or a weave carries expected checksums and optional patches.

## rom-weaver as a RomPatcher.js alternative

[RomPatcher.js](https://github.com/marcrobledo/RomPatcher.js) is Marc Robledo's project, branded [Rom Patcher JS](https://www.marcrobledo.com/RomPatcher.js/) on its website. rom-weaver is a separate project. Both apply and create ROM patches in a browser.

RomPatcher.js documents IPS, UPS, APS, BPS, RUP, PPF, and VCDIFF support, among other formats. It displays CRC32, MD5, and SHA-1, handles headers, and extracts ZIP files. Its browser, Node.js, and embedding options suit focused patching and custom release pages.

rom-weaver is an alternative when the job includes ordered patch chains, optional patches, or weave checks. It combines these with supported archive and disc-container extraction, checksums, and output compression. The [format reference](../reference/formats.md) identifies which inputs and outputs it supports.

For one supported patch, either tool may cover the job. RomPatcher.js explicitly documents embedding a custom patcher into another website. rom-weaver's [weaves](bundles.md) instead describe patch order, choices, and expected bytes across a workflow. Neither a format list nor checksum display alone proves that the starting ROM matches.

## Creating a patch

A patch creator must reproduce the intended Modified file from the documented Original. Different creators can encode different patch bytes for the same result. A smaller patch or a familiar encoder does not remove the need to test reconstruction.

[Choosing a patch format](patch-formats.md) explains the format trade-offs. [BPS implementation references](../development/references.md#bps-comparison-multipatch-and-flips) records the encoder differences relevant to rom-weaver development.

## Containers and disc images

chdman and Dolphin tool handle disc conversion directly. rom-weaver combines supported container extraction, patching, and compression in one workflow. When the required output is unsupported, a separate converter remains necessary.

Parity tests compare reconstructed payloads. They do not establish that every compressed container or patch stream is identical across tools. [Performance](../development/performance.md#benchmarks-in-this-repository) describes the parity harness.

## Native conversion speed against chdman and dolphin-tool

The recorded native CLI benchmarks show faster [CHD extraction than chdman](../development/performance.md#chd-vs-chdman) and [RVZ conversion than dolphin-tool](../development/performance.md#rvz-vs-dolphin-tool) on the measured corpus. CHD compression includes both faster and slower results.

The measurements identify the versions, machine, codec settings, input types, and timing variation. They do not establish browser speed against competitors. Z3DS conversion and patching have no competitor comparison in these results.

## Checksums

A displayed checksum identifies the bytes a tool read. Validation compares those bytes with an expected value. These are different capabilities: an IPS patch, for example, contains no expected source checksum for a patcher to check.

rom-weaver can take expected checks from a weave or explicit command options. [How patching works](how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not) explains the limits of that evidence.

## Headers and byte order

Two dumps can represent the same game in different byte layouts. Patching needs the layout the author used. rom-weaver can compare supported variants and infer some layouts when a patch lacks checksums. An unresolved case still needs the author's release information; automatic handling is not a guarantee.

## Patching features

Patch order, optional choices, and expected intermediate results are part of a release. A [weave](bundles.md) records them in a machine-readable file. With separate single-patch runs, the user or a script must preserve that information and manage intermediate outputs.

## Beyond patching

rom-weaver also identifies, hashes, trims, and compresses supported inputs. These features can reduce the number of tools in a workflow. They do not replace all operations in specialist disc or emulator tools.

## Delivery and platforms

A browser patcher avoids installation. A native application avoids browser memory and storage limits. An embeddable patcher serves a different need again: integrating patching into a release author's own page. [Browser and CLI](browser-and-cli.md) explains rom-weaver's two interfaces.

## Which one should you use?

Keep a tool that already handles your input and produces the result you need. Consider rom-weaver when repeated extraction, patching, checking, and compression are the work you want to combine. For a patch button embedded in another website, RomPatcher.js documents that use directly. For unsupported disc output, use the reference converter.

## How this page was checked

The project descriptions above use the linked upstream repositories and official chdman documentation, checked on 2026-09-05. RomPatcher.js capabilities were rechecked against its [README](https://github.com/marcrobledo/RomPatcher.js) and [official webapp](https://www.marcrobledo.com/RomPatcher.js/) on 2026-10-08. rom-weaver's details are checked against this repository's command, format, and parity-test implementations. The links are the source for current upstream capabilities.
