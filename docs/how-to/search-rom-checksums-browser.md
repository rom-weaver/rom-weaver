# Search ROM checksums in the browser

Look up a ROM by CRC32, MD5, or SHA-1 checksum without adding a file.

To identify a file, use [Identify a ROM by checksum](identify-roms-browser.md). To calculate or compare hashes, use [Calculate ROM checksums](checksum-roms-browser.md).

<!-- START doctoc -->
## Table of contents

- [Look up an existing hash](#look-up-an-existing-hash)
- [Search by game name](#search-by-game-name)
- [Check your file against a result](#check-your-file-against-a-result)

<!-- END doctoc -->

## Look up an existing hash

1. Open a fresh [Identify page](https://rom-weaver.com/identify-rom).
2. Paste your hash into **Identify by checksum or game name**.
3. Wait for the lookup to finish.
4. Select a release, even for a single result.
5. Read the expected ROM's details and **Checks**.

Paste the hexadecimal value without an algorithm label or `0x` prefix. Either letter case works.

| Algorithm | Hash length |
| --- | --- |
| CRC32 | 8 hexadecimal characters |
| MD5 | 32 hexadecimal characters |
| SHA-1 | 40 hexadecimal characters |

For SHA-256 and other hashes, use [Checksum](checksum-roms-browser.md). This lookup does not support them.

You can also paste a hash into the top-bar **Find games (by name/checksum), tools, docs, or settings...** search. Select a game to open its details in Identify.

## Search by game name

1. Enter a game name in **Identify by checksum or game name**.
2. Select the game, then its release.
3. Read the expected checksums, region, and revision where available.

Select **Try a sample** in the empty search box, then choose the matching Tetris release.

## Check your file against a result

Add your ROM to compare it with the selected release. A matching name does not confirm its revision.

A checksum can match several releases. Inspect the candidates before selecting one.

No match does not prove corruption. Modified ROMs, homebrew, and unlisted releases may lack identification records.

If data cannot load, check your connection and retry. See [Identify sources](../explanation/identify-sources.md) for coverage and offline requirements.

Search returns records, not game downloads. Identification runs locally; your file stays in the browser.
