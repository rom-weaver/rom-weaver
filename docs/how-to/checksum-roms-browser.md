# Checksum a ROM in the browser

Calculate a ROM's CRC32, MD5, SHA-1, SHA-256, or other checksum in your browser, and compare it with an expected value. The ROM is not uploaded.

To find which game a ROM contains, use [Identify a ROM](identify-roms-browser.md). For terminal procedures, see [Identify and hash ROMs from the CLI](identify-and-hash-files.md#hash-a-file).

<!-- START doctoc -->
## Table of contents

- [Calculate checksums](#calculate-checksums)
- [Add an algorithm](#add-an-algorithm)
- [Compare with an expected checksum](#compare-with-an-expected-checksum)

<!-- END doctoc -->

## Calculate checksums

1. Open [Checksum ROM](https://rom-weaver.com/checksum).
2. Add one ROM, archive, or disc image.
3. If the archive holds more than one ROM, choose the ROM to check.
4. Wait for the ROM card to finish. **Checksums** shows its CRC32, MD5, and SHA-1.

For an archive, the checksums describe the ROM inside it, not the archive file. A multi-track disc gets one group of checksums for each track.

Select a checksum row to copy its value.

## Add an algorithm

1. In **Checksums**, turn on the algorithm, for example **SHA-256**.
2. Select **Calculate SHA-256**.

To stop a long calculation, cancel it from the progress bar. The checksums already shown stay.

The [checksum support table](../reference/formats.md#checksum-support) lists every algorithm.

## Compare with an expected checksum

1. Paste the expected value into **Compare with an expected checksum**.
2. Read the result under the field.

A match names the algorithm and the bytes that matched. When the ROM has a copier header or a different byte order, rom-weaver also lists those variants, and a match on a variant names it. Give a patch the form of the ROM that its author specifies.

A value of 8 or 64 characters can belong to more than one algorithm. If rom-weaver asks you to calculate another algorithm, turn it on and calculate it.

If no checksum matches, follow [Fix a checksum error](fix-checksum-errors.md).
