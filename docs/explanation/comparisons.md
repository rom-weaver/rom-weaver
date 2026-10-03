# ROM tool comparison: patching, RVZ and CHD

Compare rom-weaver with online RVZ to ISO converters, CHD extraction and compression websites, and ROM patchers. Compare supported output and local processing.

<!-- START doctoc -->
## Table of contents

- [The tools](#the-tools)
- [At a glance](#at-a-glance)
- [Applying a patch](#applying-a-patch)
- [Creating a patch](#creating-a-patch)
- [Containers and disc images](#containers-and-disc-images)
- [Online RVZ to ISO converters](#online-rvz-to-iso-converters)
- [Online CHD extraction and compression](#online-chd-extraction-and-compression)
- [Threading and measured conversion speed](#threading-and-measured-conversion-speed)
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
| rom-weaver | Extraction, patch chains, checksums, compression, and bundles in a browser or native CLI | More controls than a single-purpose patcher; browser storage limits still apply. |
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

For a single uncompressed ROM and a supported patch, a focused patcher can be sufficient. rom-weaver becomes useful when the input needs extraction, several patches must run in order, or a bundle carries expected checksums and optional patches.

## Creating a patch

A patch creator must reproduce the intended Modified file from the documented Original. Different creators can encode different patch bytes for the same result. A smaller patch or a familiar encoder does not remove the need to test reconstruction.

[Choosing a patch format](patch-formats.md) explains the format trade-offs. [BPS implementation references](../development/references.md#bps-comparison-multipatch-and-flips) records the encoder differences relevant to rom-weaver development.

## Containers and disc images

chdman and Dolphin tool handle disc conversion directly. rom-weaver combines supported container extraction, patching, and compression in one workflow. When the required output is unsupported, a separate converter remains necessary.

Parity tests compare reconstructed payloads. They do not establish that every compressed container or patch stream is identical across tools. [Performance](../development/performance.md#benchmarks-in-this-repository) describes the parity harness.

## Online RVZ to ISO converters

RVZ extraction restores a GameCube or Wii disc image to ISO. A website can run the conversion locally or upload the image for server processing.

| Website | RVZ extraction | Processing and trade-off |
| --- | --- | --- |
| [rom-weaver](https://rom-weaver.com/extract) | RVZ to ISO | Runs locally in browser workers without a ROM upload or account. Browser storage and device resources limit conversion. |
| [RVZtoISO.com](https://rvztoiso.com/) | RVZ to ISO | Advertises server conversion with Dolphin, resumable uploads, paid credits, and expiring downloads. Requires uploading the source and downloading the result. |

rom-weaver also supports ISO to RVZ compression. Its [RVZ to ISO guide](../how-to/convert-rvz-to-iso-browser.md) and [ISO to RVZ guide](../how-to/convert-to-rvz-browser.md) cover the browser workflows.

## Online CHD extraction and compression

CHD extraction output depends on the stored media. CD tracks can need BIN/CUE files; a single ISO cannot represent every CHD layout.

| Website | CHD compression | CHD extraction | Processing and trade-off |
| --- | --- | --- | --- |
| [rom-weaver](https://rom-weaver.com/compress) | Compatible ISO, BIN/CUE, and GDI inputs | Supported CHD images through Extract; output depends on media | Local browser processing without a ROM upload or account. Needs local working space. |
| [CHDman.com ROM Tools](https://chdman.com/) | Advertises CD/DVD image compression | Not established by the published compressor page | Browser CHDMAN tool with lossless FLAC and optional lossy FSLAC audio settings. Lossy audio changes the source data. |
| [RVZtoISO.com](https://rvztoiso.com/iso-to-chd) | Advertises CD-based data-track ISO to CHD | Its [CHD to ISO page](https://rvztoiso.com/chd-to-iso) advertises CD-based data images; excludes hard disks and unsupported multi-track layouts | Server conversion with uploads and expiring downloads. Published size and payment limits apply. |

The CHDman.com name refers to a website. MAME's [chdman](https://docs.mamedev.org/tools/chdman.html) is the reference command-line tool listed above.

rom-weaver's [CHD compression guide](../how-to/convert-to-chd-browser.md) covers compatible inputs. Its [extraction guide](../how-to/extract-files-browser.md) covers unpacking existing CHD images. The [format reference](../reference/formats.md) lists supported CHD media and codecs.

rom-weaver supports multithreaded RVZ and CHD extraction and compression in the browser and native CLI. Automatic thread selection uses available device resources. The [browser settings guide](../how-to/browser-settings.md) covers worker thread controls.

Local processing avoids the source upload and result download. Server processing moves conversion work off the device. Cross-site browser timings have not been measured.

## Threading and measured conversion speed

The [recorded native benchmarks](../development/performance.md#results) compare rom-weaver with chdman and dolphin-tool at matched codec settings.

| Operation | Reference tool | Recorded rom-weaver result |
| --- | --- | --- |
| CHD extraction | chdman 0.287 | 3.1–5.8× faster |
| RVZ to ISO extraction | dolphin-tool | 1.6–2.0× faster |
| CHD compression | chdman 0.287 | 8% slower to 20% faster |
| ISO to RVZ compression | dolphin-tool | 1.2–1.3× faster |

These timings cover rom-weaver 0.8.0 on a quiet 10-core arm64 machine, measured on 2026-07-26. Each command had one warmup and three timed runs. Results cover the tested discs and settings; they do not measure competing websites or guarantee the same gains in a browser.

## Checksums

A displayed checksum identifies the bytes a tool read. Validation compares those bytes with an expected value. These are different capabilities: an IPS patch, for example, contains no expected source checksum for a patcher to check.

rom-weaver can take expected checks from a bundle or explicit command options. [How patching works](how-patching-works.md#what-a-checksum-proves-and-what-a-filename-does-not) explains the limits of that evidence.

## Headers and byte order

Two dumps can represent the same game in different byte layouts. Patching needs the layout the author used. rom-weaver can compare supported variants and infer some layouts when a patch lacks checksums. An unresolved case still needs the author's release information; automatic handling is not a guarantee.

## Patching features

Patch order, optional choices, and expected intermediate results are part of a release. A [bundle](bundles.md) records them in a machine-readable file. With separate single-patch runs, the user or a script must preserve that information and manage intermediate outputs.

## Beyond patching

rom-weaver also identifies, hashes, trims, and compresses supported inputs. These features can reduce the number of tools in a workflow. They do not replace all operations in specialist disc or emulator tools.

## Delivery and platforms

A browser patcher avoids installation. A native application avoids browser memory and storage limits. An embeddable patcher serves a different need again: integrating patching into a release author's own page. [Browser and CLI](browser-and-cli.md) explains rom-weaver's two interfaces.

## Which one should you use?

Keep a tool that already handles your input and produces the result you need. Consider rom-weaver when repeated extraction, patching, checking, and compression are the work you want to combine. For a patch button embedded in another website, RomPatcher.js documents that use directly. For unsupported disc output, use the reference converter.

## How this page was checked

The project descriptions above use the linked upstream repositories and official chdman documentation, checked on 2026-09-05. rom-weaver's details are checked against this repository's command, format, and parity-test implementations. The links are the source for current upstream capabilities.

The website comparison was checked on 2026-10-02 against the linked RVZtoISO.com pages and CHDman.com’s published interface. Website capabilities are advertised claims, not independently tested conversions. Prices, limits, and support can change.
