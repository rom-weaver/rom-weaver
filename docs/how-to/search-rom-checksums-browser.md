# Search ROM checksums in the browser

Use ROM hash lookup to search identification data with an existing CRC32, MD5, or SHA-1 checksum. You do not need to add a ROM file.

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
4. Select the release you want to inspect, even when only one result appears.
5. Read the expected ROM's details and **Checks**.

Paste only the hexadecimal value, without an algorithm label or `0x` prefix. Uppercase and lowercase letters both work.

| Algorithm | Hash length |
| --- | --- |
| CRC32 | 8 hexadecimal characters |
| MD5 | 32 hexadecimal characters |
| SHA-1 | 40 hexadecimal characters |

SHA-256 and other hashes can be calculated in [Checksum](checksum-roms-browser.md), but cannot be used in this lookup.

You can also paste a supported hash into the top-bar **Find games (by name/checksum), tools, docs, or settings...** search. Select a game result to open its details in Identify.

## Search by game name

1. Enter a game name in **Identify by checksum or game name**.
2. Select the game, then its release.
3. Read the expected checksums, region, and revision where available.

For a built-in example, select **Try a sample** inside the empty search box. Then choose the matching Tetris release.

## Check your file against a result

Add your ROM after selecting a release to compare it with that expectation. A name match alone does not establish the correct revision.

If several records share a checksum, inspect the candidates before selecting one. A single hash can leave several possible releases.

No match means the available identification data has no matching record. It does not prove corruption. Modified ROMs, homebrew, and unlisted releases may have no match.

If identification data cannot load, check your connection and retry. See [Where identify data comes from](../explanation/identify-sources.md) for coverage and offline requirements.

Search returns database records, not game downloads. ROM identification runs locally; your file stays in the browser.
