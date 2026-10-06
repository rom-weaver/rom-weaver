# Identify and check a ROM in the browser

Identify a ROM by checksum to find its known game name, region, and revision in the available identification data. Your file stays on your device.

Choose [Checksum](checksum-roms-browser.md) to calculate a file's hash and compare it with a published value. Choose [Test](test-roms-in-browser.md) to run a supported game in an emulator; successful playback does not establish that it is the exact ROM a patch requires.

<!-- START doctoc -->
## Table of contents

- [Identify a file](#identify-a-file)
- [Search without a file](#search-without-a-file)
- [Inspect known cheats](#inspect-known-cheats)
- [Compare a checksum](#compare-a-checksum)

<!-- END doctoc -->

## Identify a file

1. Open [Identify](https://rom-weaver.com/identify-rom).
2. Add your ROM or a supported archive.
3. Wait for identification to finish.
4. Read the **Identify** and **Checks** drawers on the ROM card.

An archive can produce several results. Each result names its member so you can tell which ROM it describes.

An unknown result means no matching checksum was found in the available data. It does not prove that your file is corrupt. Homebrew, modified ROMs, and unlisted releases can be unknown.

If several records share the checksums, read every candidate. If identification data could not load, check your connection and select **Retry identification**.

<figure class="docs-screenshot">
  <picture data-docs-screenshot-theme="light">
    <source media="(max-width: 520px)" type="image/avif" srcset="../screenshots/identify-checks-mobile-light.avif" width="1170" height="2321">
    <source type="image/avif" srcset="../screenshots/identify-checks-desktop-light.avif" width="1770" height="1500">
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/identify-checks-mobile-light.webp" width="1170" height="2321">
    <img src="../screenshots/identify-checks-desktop-light.webp" alt="Identify result for the homebrew sample with no database match and visible checksum rows in the light theme" width="1770" height="1500">
  </picture>
  <picture data-docs-screenshot-theme="dark">
    <source media="(max-width: 520px)" type="image/avif" srcset="../screenshots/identify-checks-mobile-dark.avif" width="1170" height="2321">
    <source type="image/avif" srcset="../screenshots/identify-checks-desktop-dark.avif" width="1770" height="1500">
    <source media="(max-width: 520px)" type="image/webp" srcset="../screenshots/identify-checks-mobile-dark.webp" width="1170" height="2321">
    <img src="../screenshots/identify-checks-desktop-dark.webp" alt="Identify result for the homebrew sample with no database match and visible checksum rows in the dark theme" width="1770" height="1500">
  </picture>
  <figcaption>An unknown ROM still has checksums. This example uses the supplied homebrew ROM.</figcaption>
</figure>

## Search without a file

1. Open a fresh [Identify page](https://rom-weaver.com/identify-rom).
2. Enter a checksum or game name in **Identify by checksum or game name**.
3. For a name search, select the game, then its release.
4. Read the expected ROM's details. Add your file to compare it with that expectation.

Search finds database records. It does not download a game. A name match alone does not prove that you have the right revision.

To try identification without a file, select **Try a sample** inside the empty search box, then choose the matching Tetris release.

## Inspect known cheats

1. Add a ROM or archive and wait for Identify to finish.
2. Select **View cheats** on the matching result or expected-ROM candidate.
3. Search the matched game's known codes.
4. Open **Code details** for original database fields and import warnings.

This view is for inspection. It includes checksum-only matches and candidates found inside archives, even when rom-weaver has not verified that a code is compatible with those exact bytes. Open [Apply cheats](https://rom-weaver.com/apply-patches?guide=apply-cheats) or [Create a cheat patch](https://rom-weaver.com/create-patch?guide=create-cheats) to classify and use a code.

## Compare a checksum

Open **Checks** on the ROM card. Compare the same algorithm with the value in the patch author's notes. Select a checksum row to copy it.

For an archive, these checks describe the ROM inside it. A checksum for the ZIP itself is different.

Some cards include variants, such as a ROM without its copier header. Compare the form the author specifies. If the values differ, follow [Fix a checksum error](fix-checksum-errors.md).

For SHA-256 and other algorithms, or to compare a pasted value automatically, use [Checksum a ROM](checksum-roms-browser.md).

For data sources and offline requirements, see [Where identify data comes from](../explanation/identify-sources.md). Terminal procedures are in [Identify and hash ROMs from the CLI](identify-and-hash-files.md).
