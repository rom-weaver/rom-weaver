# Performance

This page explains how rom-weaver is benchmarked. It lists the current numbers and shows how to reproduce them.

The suites below measure CHD, RVZ, 7z, and zip against their reference tools. Each suite measures both directions: compress and extract. Output size is recorded next to every timing.

<!-- START doctoc -->
## Table of contents

- [Summary](#summary)
- [Benchmarks in this repository](#benchmarks-in-this-repository)
- [Method](#method)
  - [Settings](#settings)
  - [Two chdman behaviors the harness works around](#two-chdman-behaviors-the-harness-works-around)
- [Results](#results)
  - [CHD vs chdman](#chd-vs-chdman)
    - [Extract](#extract)
    - [Compress](#compress)
  - [RVZ vs dolphin-tool](#rvz-vs-dolphin-tool)
    - [Extract (RVZ → ISO)](#extract-rvz-%E2%86%92-iso)
    - [Compress (ISO → RVZ)](#compress-iso-%E2%86%92-rvz)
  - [7z vs 7zz](#7z-vs-7zz)
    - [Compress](#compress-1)
    - [Extract](#extract-1)
  - [zip vs Info-ZIP](#zip-vs-info-zip)
    - [Extract](#extract-2)
    - [Compress](#compress-2)
- [Reproducing](#reproducing)

<!-- END doctoc -->

## Summary

Ratios compare wall time. "2× faster" means the reference tool took twice as long. Results cover this corpus, not every file. Extraction is faster in all four formats. RVZ and ZIP compression are slightly faster. 7z compression is even with 7zz. CHD compression ranges from even to 1.3× faster. Output sizes match the references to within a fraction of a percent everywhere.

| Suite | Reference | Compress | Extract | Output size |
| --- | --- | --- | --- | --- |
| CHD | chdman 0.287 | even to 1.3× faster | 3.1–5.8× faster (6–22 s per disc) | within 0.3% |
| RVZ | dolphin-tool | 1.2–1.3× faster | 1.6–2.0× faster | within 0.5% |
| 7z | 7zz 26.02 | even | 1.0–4.7× faster† | within 0.001% |
| zip | Info-ZIP | 1.1–1.2× faster | 1.6–2.7× faster | within 0.1% |

† The 7z extract timings include rom-weaver's default common-file filter. 7zz extracts those sidecar files. The multi-file result therefore measures the whole application path, not just the decoder. The filter writes 291–717 fewer bytes in this set.

## Benchmarks in this repository

| Harness | What it measures | Command |
| --- | --- | --- |
| `scripts/bench-disc-tools.mjs` | rom-weaver vs the reference tool for CHD, RVZ, 7z, and zip, compress and extract, timed by [hyperfine](https://github.com/sharkdp/hyperfine) | `mise run bench-chd`, `bench-rvz`, `bench-7z`, `bench-zip` |
| `scripts/bench-command-paths.py` | Elapsed time, peak RSS, and throughput for compress, extract, checksum, patch create, and patch apply | `python3 scripts/bench-command-paths.py` |
| `scripts/bench-checksum-threading.py` | Checksum scaling from one thread to many | `python3 scripts/bench-checksum-threading.py` |
| `scripts/bench-solid-extract.py` | Redundant decode when extracting a solid archive in parallel, as user CPU relative to one thread | `python3 scripts/bench-solid-extract.py` |
| `packages/rom-weaver-webapp/tests/wasm/*.bench.mjs` | Browser WASM worker-client and checksum threading | `npm --prefix packages/rom-weaver-webapp run test:browser:wasm:bench` |

`scripts/parity-check.mjs` is the correctness counterpart. It checks that CHD, RVZ, 7z, and ZIP payloads round-trip through rom-weaver and their reference tools in both directions. It compares extracted payload bytes. Archive metadata and compression streams differ between tools, so it cannot compare archive bytes.

## Method

`scripts/bench-disc-tools.mjs` walks a corpus directory. For each source it recognises, it builds two benchmarks: one compress and one extract. It hands both commands to [hyperfine](https://github.com/sharkdp/hyperfine), which runs a warmup pass and then the measured runs.

A `--prepare` step deletes the previous output before each run, so every run starts clean. This matters for two reasons. `rom-weaver extract` stops rather than overwrite files already in the output directory. A reference tool that skipped a write because the target existed would be timed as instant.

Output size is recorded separately, from a single untimed execution of the same command.

The warmup run puts the source in the page cache. The measured runs then compare compression work, not first-read disk latency. On a machine without room to cache the whole source, the numbers describe an I/O-bound workload instead.

Sources under 1 MB are excluded by default (`--min-size`). At that size every tool here finishes in under 20 ms, so process startup dominates the measurement.

### Settings

Both sides run at parity. Where the two tools already agree on a default, both are left alone. Where they do not, both are pinned to the *reference* tool's own default, never rom-weaver's.

| Suite | rom-weaver | Reference | Note |
| --- | --- | --- | --- |
| CHD | defaults | `chdman createcd` defaults | Both already select `cdlz,cdzl,cdfl` and use every core; rom-weaver's default is `--level max` |
| RVZ | `--codec zstd:5` | `-c zstd -l 5 -b 131072` | Dolphin's suggested RVZ settings; rom-weaver's block size is already 128 KiB (`RVZ_DEFAULT_CHUNK_SIZE`) |
| 7z | `--codec lzma2:5` | `-t7z -m0=lzma2 -mx=5 -mmt=on` | LZMA2 at 7-Zip's default level |
| zip | `--codec deflate:6` | `zip -6` | Deflate at Info-ZIP's default level |

Three further details:

- **Archive extraction is capped at one layer.** rom-weaver unpacks archives found inside archives; `7zz` and `unzip` stop after one. The harness passes `--no-nested-extract` so both sides do the same work.
- **The 7z extract path keeps rom-weaver's default common-file filter.** This skips sidecars such as provenance text files. `7zz` extracts every member. Add `--no-ignore` to the rom-weaver command in the harness for a pure decoder comparison.
- **The zip suite uses two reference binaries**, `zip` to write and `unzip` to read, since Info-ZIP splits them.
- **Sources under 1 MB are skipped** (`--min-size`). A ROM corpus carries patch bundles and manifest fixtures that are not ROMs. `--min-size 0` benchmarks everything.

### Two chdman behaviors the harness works around

- **Extraction is split across subcommands by disc type, and chdman does not pick one for you.** `extractcd` handles CD and GD-ROM. `extractdvd` handles DVD. The harness reads the CHD's own metadata tag via `chdman info` (`CHT2`/`CHTR` → CD, `CHGD` → GD-ROM, `DVD ` → DVD) and routes to the right subcommand. rom-weaver reads the same tag itself, so its side is one command for all three types.
- **A wrong subcommand fails but still exits 0.** Run `chdman extractcd` against a DVD CHD and it stops on an uncaught C++ exception, writes nothing, and returns success. Exit status alone would score that crash as an extremely fast run. Every measured command must therefore also produce a non-empty output.

## Results

`scripts/bench-disc-tools.mjs` produced these results at the codec settings in [Settings](#settings). Those settings pin both sides to the same codec, level, and block size, so the two tools do equivalent work.

**Machine:** a quiet 10-core arm64 machine, otherwise idle. **Binaries:** rom-weaver 0.8.0 built `--release`, against chdman 0.287, dolphin-tool, 7zz 26.02, and Info-ZIP. **Date:** 2026-07-26. **Runs:** three timed runs per command after one warmup; `±` is the standard deviation across those runs.

The suites ran in two sittings: `chd` and `rvz` in one, then `7z` and `zip` in a second after the archive corpus grew to include the 256 MB and 1 GiB ROMs.

One exception: the **RVZ size columns** were re-measured after [#213](https://github.com/rom-weaver/rom-weaver/pull/213), which changed how much padding RVZ compression detects. Their time columns are still from the original sitting. RVZ output is deterministic: three repeats produced bit-identical sizes. The size columns are therefore exact even though they and the time columns come from different runs. #213 touches only GameCube junk detection, so no other suite was affected.

The **7z tables** below replace the earlier 7z results. They were rerun on 2026-08-04, after native LZMA2 writes and eligible LZMA1/LZMA2 reads moved onto 7-Zip's own LZMA SDK - the same coders `7zz` runs. Filter chains, LZMA1 writes, and WebAssembly writes stay on liblzma.

The rerun used an Apple M1 Max, rom-weaver 0.11.1, and 7zz 26.02. Each command had one warmup and three measured runs. Hyperfine flagged outliers on the 32 MB and 256 MB compression rows, so those row-level timings are less certain.

Time change is rom-weaver's elapsed time minus the reference tool's, in seconds and as a percentage of the reference. Negative means rom-weaver finished sooner. Size change is rom-weaver's output relative to the reference's. Negative means smaller.

The corpus is not redistributable, so sources are identified by platform and disc type rather than by title. The same label means the same source everywhere in this document.

### CHD vs chdman

Five commercial discs spanning all three CHD disc types: PS1 CDs with mixed data and audio tracks (`CHT2`), a Dreamcast GD-ROM (`CHGD`), and a PS2 DVD (`DVD `).

#### Extract

| Disc | Type | rom-weaver | chdman | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| PS1 CD A (8 tracks) | CD | 1.516 s ± 0.011 | 7.517 s ± 0.023 | −6.001 s (−79.8%) | 515.4 MB |
| PS1 CD B | CD | 2.021 s ± 0.008 | 11.807 s ± 0.026 | −9.786 s (−82.9%) | 602.8 MB |
| PS1 CD C | CD | 2.967 s ± 0.018 | 16.074 s ± 0.033 | −13.107 s (−81.5%) | 657.2 MB |
| GD-ROM A | GD-ROM | 5.394 s ± 0.096 | 27.031 s ± 0.032 | −21.637 s (−80.0%) | 1,145.4 MB |
| PS2 DVD | DVD | 5.726 s ± 0.062 | 17.766 s ± 0.034 | −12.040 s (−67.8%) | 1,697.8 MB |

rom-weaver extracted these discs 3.1–5.8× faster than chdman — 6 to 22 seconds sooner per disc.

Output sizes agree with chdman's to within 72 bytes on every disc. The difference is cue-sheet text - track naming and line endings - not image data.

#### Compress

| Disc | Type | rom-weaver | chdman | Time change | rom-weaver | chdman | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PS1 CD A (8 tracks) | CD | 9.080 s ± 0.485 | 8.402 s ± 0.032 | +0.678 s (+8.1%) | 243.7 MB | 244.4 MB | −0.27% |
| PS1 CD C | CD | 13.887 s ± 0.087 | 15.110 s ± 0.081 | −1.223 s (−8.1%) | 419.2 MB | 419.5 MB | −0.07% |
| GD-ROM B | GD-ROM | 13.855 s ± 0.085 | 17.382 s ± 0.048 | −3.527 s (−20.3%) | 646.8 MB | 646.8 MB | −0.01% |
| GD-ROM A | GD-ROM | 15.712 s ± 0.161 | 18.675 s ± 0.364 | −2.963 s (−15.9%) | 872.2 MB | 872.3 MB | −0.01% |

Compression ranges from 8% slower to 20% faster across the four discs, with output up to 0.7 MB smaller.

### RVZ vs dolphin-tool

Two GameCube titles. The `.rvz` sources are third-party dumps; the `.iso` compress inputs were produced by extracting them.

#### Extract (RVZ → ISO)

| Disc | rom-weaver | dolphin-tool | Time change | Output |
| --- | --- | --- | --- | --- |
| GameCube A | 0.350 s ± 0.013 | 0.543 s ± 0.023 | −0.193 s (−35.5%) | 1,392.3 MB |
| GameCube B | 0.357 s ± 0.015 | 0.718 s ± 0.021 | −0.361 s (−50.3%) | 1,392.3 MB |

rom-weaver extracts these two discs 1.6–2.0× faster.

#### Compress (ISO → RVZ)

| Disc | rom-weaver | dolphin-tool | Time change | rom-weaver | dolphin | Size change |
| --- | --- | --- | --- | --- | --- | --- |
| GameCube A | 0.273 s ± 0.018 | 0.340 s ± 0.004 | −0.067 s (−19.7%) | 103.4 MB | 103.9 MB | −0.48% |
| GameCube B | 0.269 s ± 0.014 | 0.363 s ± 0.008 | −0.094 s (−25.9%) | 156.9 MB | 156.9 MB | +0.01% |

Times here are sub-second because most of a GameCube disc is pseudorandom padding. RVZ stores that padding as a seed instead of compressing it. Only the real payload, roughly 100–160 MB of a 1.46 GB disc, reaches the compressor.

Both directions are lossless. Extracting either tool's RVZ reproduces the source ISO's SHA-1 exactly, and the two extracted ISOs are byte-identical to each other.

GameCube A measured +8.38% before #213, which changed junk detection to read the GameCube filesystem table for file end offsets.

### 7z vs 7zz

LZMA2 at level 5 on both sides. The compress inputs are cartridge ROMs, 16 MB to 1 GiB. Disc images are excluded here because the `chd` and `rvz` suites already measure them. The `.7z` archives read back on the extract side do contain disc images.

#### Compress

| Input | Input size | rom-weaver | 7zz | Time change | rom-weaver | 7zz | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GBA ROM `.gba` | 16 MB | 0.980 s ± 0.003 | 1.048 s ± 0.068 | −0.068 s (−6.5%) | 5.5 MB | 5.5 MB | −0.0004% |
| GBA ROM (romhack) `.gba` | 32 MB | 2.281 s ± 0.285 | 2.228 s ± 0.007 | +0.053 s (+2.4%) | 9.7 MB | 9.7 MB | −0.0002% |
| DS ROM `.nds` | 256 MB | 10.369 s ± 1.105 | 9.819 s ± 0.199 | +0.550 s (+5.6%) | 61.0 MB | 61.0 MB | −0.00003% |
| 3DS ROM `.cci` | 1 GiB | 15.267 s ± 0.115 | 15.780 s ± 0.239 | −0.513 s (−3.3%) | 315.5 MB | 315.5 MB | −0.000007% |

The SDK encoder keeps compression even with 7zz: every row is within ±6%, and the archives are 19–24 bytes smaller. The archive bytes are not expected to be identical, because the tools write different metadata. The parity check compares the extracted payload instead.

`ROM_WEAVER_7Z_ENCODER=liblzma` still selects the seeded liblzma encoder. The legacy encoder is not measured in this table.

#### Extract

| Input | Input size | rom-weaver | 7zz | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| GameCube A `.7z` | 77 MB | 2.529 s ± 0.018 | 2.572 s ± 0.003 | −0.043 s (−1.7%) | 227.4 MB |
| PS1 CD A `.7z` | 287 MB | 2.237 s ± 0.003 | 10.495 s ± 0.014 | −8.258 s (−78.7%) | 515.4 MB |
| 3DS ROM `.7z` | 297 MB | 9.496 s ± 0.015 | 9.724 s ± 0.013 | −0.229 s (−2.4%) | 1,024.0 MB |
| PS1 CD C `.7z` | 458 MB | 14.291 s ± 0.097 | 14.428 s ± 0.055 | −0.137 s (−1.0%) | 657.2 MB |
| GD-ROM B `.7z` | 673 MB | 20.644 s ± 0.066 | 21.167 s ± 0.344 | −0.522 s (−2.5%) | 1,134.7 MB |

The output size column counts bytes written by each tool. rom-weaver's default common-file filter skips sidecar files that 7zz writes, so its output is 291–717 bytes smaller on these rows. PS1 CD A contains eight track files plus sidecars. Its large lead (4.7×) combines multi-file extraction with that filtering. The other rows are 1.01–1.03× faster with rom-weaver, and they still include the same filtering difference.

For a pure decoder comparison, pass `--no-ignore` to rom-weaver's extract command in the harness. The portable decoder also optimizes repeated-byte matches; see the targeted measurements in [`vendor-code.md`](vendor-code.md).

These numbers are arm64, where that loop needs no extra tooling. On x86-64 the loop is MASM assembly. The build only uses it when a MASM-compatible assembler is on `PATH`: the shipped Linux x86-64 (glibc) and Windows x86-64 builds have one, and `x86_64-apple-darwin` never does. A build without one keeps the C decoder, lands roughly where the old rows did, and says so in a `cargo:warning`. See [Which platforms get the assembly decode loop](vendor-code.md#which-platforms-get-the-assembly-decode-loop) for the full matrix.

### zip vs Info-ZIP

Deflate at level 6 on both sides; `zip` writes, `unzip` reads.

#### Extract

| Input | Input size | rom-weaver | unzip | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| GBA ROM `.zip` | 6.7 MB | 0.065 s ± 0.001 | 0.120 s ± 0.000 | −0.055 s (−45.9%) | 16.0 MB |
| Patch bundle `.zip` | 8.9 MB | 0.060 s ± 0.001 | 0.095 s ± 0.001 | −0.035 s (−37.0%) | 10.1 MB |
| GBA ROM (romhack) `.zip` | 11.7 MB | 0.110 s ± 0.001 | 0.224 s ± 0.001 | −0.114 s (−51.0%) | 32.0 MB |
| N64 ROM `.zip` | 24.9 MB | 0.177 s ± 0.003 | 0.479 s ± 0.024 | −0.303 s (−63.2%) | 32.0 MB |
| DS ROM `.zip` | 106 MB | 0.843 s ± 0.003 | 1.723 s ± 0.022 | −0.880 s (−51.1%) | 256.0 MB |
| GameCube mod `.zip` | 124 MB | 0.568 s ± 0.028 | 1.087 s ± 0.041 | −0.519 s (−47.8%) | 131.6 MB |

rom-weaver extracts these archives 1.6–2.7× faster than `unzip`.

#### Compress

| Input | Input size | rom-weaver | zip | Time change | rom-weaver | zip | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GBA ROM `.gba` | 16 MB | 0.392 s ± 0.003 | 0.424 s ± 0.002 | −0.032 s (−7.5%) | 6.7 MB | 6.7 MB | −0.03% |
| GBA ROM (romhack) `.gba` | 32 MB | 0.746 s ± 0.002 | 0.828 s ± 0.011 | −0.083 s (−10.0%) | 11.8 MB | 11.8 MB | −0.01% |
| DS ROM `.nds` | 256 MB | 6.197 s ± 0.049 | 7.683 s ± 1.429 | −1.487 s (−19.3%) | 105.8 MB | 105.9 MB | −0.10% |
| 3DS ROM `.cci` | 1 GiB | 16.451 s ± 1.119 | 19.924 s ± 1.868 | −3.473 s (−17.4%) | 373.9 MB | 373.8 MB | +0.02% |

rom-weaver compresses 1.1–1.2× faster than `zip`, with output within 0.1% of Info-ZIP's.

Info-ZIP's run-to-run spread on the two largest compress inputs (± 1.4 s and ± 1.9 s) is wide, so those two percentages are not precise.

## Reproducing

```bash
cargo build --release -p rom-weaver-cli
npm install --global chdman dolphin-tool   # or your distribution's packages
brew install hyperfine sevenzip            # zip/unzip ship with macOS

BENCH_CORPUS=/path/to/corpus mise run bench-chd
BENCH_CORPUS=/path/to/corpus mise run bench-rvz
BENCH_CORPUS=/path/to/corpus mise run bench-7z
BENCH_CORPUS=/path/to/corpus mise run bench-zip
```

All four tasks wrap one script. Call it directly for anything they do not expose:

```bash
node scripts/bench-disc-tools.mjs --suite rvz --corpus /path/to/corpus --runs 5
```

The corpus is deliberately not in the repository. These benchmarks need real ROMs and disc images, which are not redistributable. Point `--corpus` (or `BENCH_CORPUS`) at a directory of your own. The harness discovers sources up to three levels deep, so the usual one-directory-per-title layout works as-is. Each suite picks up only what it can use:

| Suite | Reference | Compress inputs | Extract inputs |
| --- | --- | --- | --- |
| `chd` | `chdman` | `.cue` | `.chd` |
| `rvz` | `dolphin-tool` | `.iso`, `.gcm` | `.rvz` |
| `7z` | `7zz` | ROM files | `.7z` |
| `zip` | `zip` / `unzip` | ROM files | `.zip` |

"ROM files" means `.gba`, `.nds`, `.3ds`, `.cci`, `.sfc`, `.smc`, `.n64`, `.z64`, `.nes`, `.gb`, `.gbc`. These cartridge dumps range from a 128 KB NES ROM to a 1 GiB 3DS image. Some of the larger ones only exist inside the corpus's own archives. Extract those once and the archive suites pick them up.

Flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--suite <chd\|rvz\|7z\|zip>` | `chd` | Which format and reference tool to benchmark |
| `--corpus <dir>` | required | Directory of ROMs or disc images |
| `--out <dir>` | `dist/bench/disc-tools` | Where `report-<suite>.json` and the per-case hyperfine JSON land |
| `--cases compress,extract` | both | Restrict to one direction |
| `--min-size <MB>` | 1 | Skip sources smaller than this; `0` benchmarks everything |
| `--runs <n>` | 3 | Measured runs per command |
| `--warmup <n>` | 1 | Warmup runs per command |
| `--rom-weaver-bin <path>` | `target/release/rom-weaver` | Binary under test |
| `--reference-bin <path>` | per suite | Reference binary |

`report-<suite>.json` records the host CPU, the rom-weaver version, the reference tool, the run counts, and for every case both tools' timings and output sizes.

A source one tool declines is recorded as a skip and the run continues.
