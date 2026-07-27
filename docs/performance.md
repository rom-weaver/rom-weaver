# Performance

How rom-weaver is benchmarked, what the numbers currently are, and how to
reproduce them.

Every format is measured against the tool that defines it, in both directions —
compress and extract — with output size recorded next to every timing.

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

Times are rom-weaver's elapsed time relative to the reference tool's, so a
negative percentage means rom-weaver finished sooner. Sizes are rom-weaver's
output relative to the reference's, so negative means smaller.

| Suite | Reference | Compress time | Extract time | Size vs reference |
| --- | --- | --- | --- | --- |
| CHD | chdman 0.287 | −20.3% to +8.1% | −67.8% to −82.9% | −0.27% to −0.01% |
| RVZ | dolphin-tool | −19.7% to −25.9% | −35.5% to −50.3% | −0.48% to +0.01% |
| 7z | 7zz 26.02 | −2.7% to +1.1% | −67.4% to +2.3% | −0.00% to +0.16% |
| zip | Info-ZIP | −7.5% to −19.3% | −37.0% to −63.2% | −0.10% to +0.02% |

## Benchmarks in this repository

| Harness | What it measures | Command |
| --- | --- | --- |
| `scripts/bench-disc-tools.mjs` | rom-weaver vs the reference tool for CHD, RVZ, 7z, and zip, compress and extract, timed by [hyperfine](https://github.com/sharkdp/hyperfine) | `mise run bench-chd`, `bench-rvz`, `bench-7z`, `bench-zip` |
| `scripts/bench-command-paths.py` | Elapsed time, peak RSS, and throughput across every CLI command path | `python3 scripts/bench-command-paths.py` |
| `scripts/bench-checksum-threading.py` | Checksum scaling from one thread to many | `python3 scripts/bench-checksum-threading.py` |
| `packages/rom-weaver-webapp/tests/wasm/*.bench.mjs` | Browser WASM worker-client and checksum threading | `npm --prefix packages/rom-weaver-webapp run test:browser:wasm` |

`scripts/parity-check.mjs` is the correctness counterpart: it checks that
rom-weaver's CHD output round-trips through chdman and its RVZ output through
dolphin-tool, and vice versa.

## Method

`scripts/bench-disc-tools.mjs` walks a corpus directory and builds two
benchmarks per source it recognises — one compress, one extract — then hands both
commands to [hyperfine](https://github.com/sharkdp/hyperfine), which runs a
warmup pass followed by the measured runs.

Each run is preceded by a `--prepare` step that deletes the previous output, so
every run starts from the same clean slate: `rom-weaver extract` stops rather
than overwrite files already in the output directory, and a reference tool that
skipped a write because the target existed would be timed as instant.

Output size is recorded separately, from a single untimed execution of the same
command.

The warmup run puts the source in the page cache, so the measured runs compare
compression work rather than first-read disk latency. On a machine without room
to cache the whole source, the numbers describe an I/O-bound workload instead.

Sources under 1 MB are excluded by default (`--min-size`); at that size every
tool here finishes in under 20 ms and the measurement is dominated by process
startup.

### Settings

Both sides run at parity: where two tools already agree on a default, both are
left alone; where they do not, both are pinned to the *reference* tool's own
default, never rom-weaver's.

| Suite | rom-weaver | Reference | Note |
| --- | --- | --- | --- |
| CHD | defaults | `chdman createcd` defaults | Both already select `cdlz,cdzl,cdfl` and use every core; rom-weaver's default is `--level max` |
| RVZ | `--codec zstd:5` | `-c zstd -l 5 -b 131072` | Dolphin's suggested RVZ settings; rom-weaver's block size is already 128 KiB (`RVZ_DEFAULT_CHUNK_SIZE`) |
| 7z | `--codec lzma2:5` | `-t7z -m0=lzma2 -mx=5 -mmt=on` | LZMA2 at 7-Zip's default level |
| zip | `--codec deflate:6` | `zip -6` | Deflate at Info-ZIP's default level |

Three further details:

- **Archive extraction is capped at one layer.** rom-weaver unpacks archives
  found inside archives; `7zz` and `unzip` stop after one. The harness passes
  `--no-nested-extract` so both sides do the same work.
- **The zip suite uses two reference binaries**, `zip` to write and `unzip` to
  read, since Info-ZIP splits them.
- **Sources under 1 MB are skipped** (`--min-size`). A ROM corpus carries patch
  bundles and manifest fixtures that are not ROMs. `--min-size 0` benchmarks
  everything.

### Two chdman behaviors the harness works around

- **Extraction is split across subcommands by disc type, and chdman picks none
  of them for you.** `extractcd` handles CD and GD-ROM, `extractdvd` handles
  DVD. The harness reads the CHD's own metadata tag via `chdman info`
  (`CHT2`/`CHTR` → CD, `CHGD` → GD-ROM, `DVD ` → DVD) and routes accordingly.
  rom-weaver reads the same tag itself, which is why its side is one command for
  all three.
- **A wrong subcommand fails but still exits 0.** `chdman extractcd` against a
  DVD CHD terminates on an uncaught C++ exception, writes nothing, and returns
  success — exit status alone would score that crash as an extremely fast run.
  Every measured command is therefore also required to produce a non-empty
  output.

## Results

Produced by `scripts/bench-disc-tools.mjs` at the codec settings in
[Settings](#settings), which pin both sides to the same codec, level, and block
size so the two tools are doing equivalent work.

**Machine:** a quiet 10-core arm64 machine, otherwise idle.
**Binaries:** rom-weaver 0.8.0 built `--release`, against chdman 0.287,
dolphin-tool, 7zz 26.02, and Info-ZIP.
**Date:** 2026-07-26.
**Runs:** three timed runs per command after one warmup; `±` is the standard
deviation across those runs.

Each group of suites ran back to back — `chd` and `rvz` in one sitting, `7z` and
`zip` in a second after the archive corpus grew to include the 256 MB and 1 GiB
ROMs.

One exception: the **RVZ size columns** were re-measured after
[#213](https://github.com/rom-weaver/rom-weaver/pull/213), which changed how much
padding RVZ compression detects. Their time columns are still from the original
sitting. RVZ output is deterministic — three repeats produced bit-identical
sizes — so the size columns are exact even though they and the time columns come
from different runs. #213 touches only GameCube junk detection, so no other suite
was affected.

The **7z tables** were re-measured in full a second time on the `lzma-sdk`
branch, which moves both 7z paths off liblzma and onto 7-Zip's own LZMA SDK -
the same coders `7zz` runs. Both tables changed enough that nothing from the
earlier sittings survives in them. The first re-measure was after
[#215](https://github.com/rom-weaver/rom-weaver/pull/215) (seeded parallel
blocks, 7-Zip's per-level dictionary sizes, pipelined single-member extraction),
which bought output smaller than 7zz's at the cost of compress time; the SDK
swap gives that fraction of a percent of size back and takes the time.

Time change is rom-weaver's elapsed time minus the reference tool's, in seconds
and as a percentage of the reference, so negative means rom-weaver finished
sooner. Size change is rom-weaver's output relative to the reference's, so
negative means smaller.

Sources are identified by platform and disc type rather than by title, since the
corpus is not redistributable. The same label means the same source everywhere in
this document.

### CHD vs chdman

Five commercial discs spanning all three CHD disc types: PS1 CDs with mixed data
and audio tracks (`CHT2`), a Dreamcast GD-ROM (`CHGD`), and a PS2 DVD (`DVD `).

#### Extract

| Disc | Type | rom-weaver | chdman | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| PS1 CD A (8 tracks) | CD | 1.516 s ± 0.011 | 7.517 s ± 0.023 | −6.001 s (−79.8%) | 515.4 MB |
| PS1 CD B | CD | 2.021 s ± 0.008 | 11.807 s ± 0.026 | −9.786 s (−82.9%) | 602.8 MB |
| PS1 CD C | CD | 2.967 s ± 0.018 | 16.074 s ± 0.033 | −13.107 s (−81.5%) | 657.2 MB |
| GD-ROM A | GD-ROM | 5.394 s ± 0.096 | 27.031 s ± 0.032 | −21.637 s (−80.0%) | 1,145.4 MB |
| PS2 DVD | DVD | 5.726 s ± 0.062 | 17.766 s ± 0.034 | −12.040 s (−67.8%) | 1,697.8 MB |

Output sizes agree with chdman's to within 72 bytes on every disc; the difference
is cue-sheet text — track naming and line endings — not image data.

#### Compress

| Disc | Type | rom-weaver | chdman | Time change | rom-weaver | chdman | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PS1 CD A (8 tracks) | CD | 9.080 s ± 0.485 | 8.402 s ± 0.032 | +0.678 s (+8.1%) | 243.7 MB | 244.4 MB | −0.27% |
| PS1 CD C | CD | 13.887 s ± 0.087 | 15.110 s ± 0.081 | −1.223 s (−8.1%) | 419.2 MB | 419.5 MB | −0.07% |
| GD-ROM B | GD-ROM | 13.855 s ± 0.085 | 17.382 s ± 0.048 | −3.527 s (−20.3%) | 646.8 MB | 646.8 MB | −0.01% |
| GD-ROM A | GD-ROM | 15.712 s ± 0.161 | 18.675 s ± 0.364 | −2.963 s (−15.9%) | 872.2 MB | 872.3 MB | −0.01% |

### RVZ vs dolphin-tool

Two GameCube titles. The `.rvz` sources are third-party dumps; the `.iso`
compress inputs were produced by extracting them.

#### Extract (RVZ → ISO)

| Disc | rom-weaver | dolphin-tool | Time change | Output |
| --- | --- | --- | --- | --- |
| GameCube A | 0.350 s ± 0.013 | 0.543 s ± 0.023 | −0.193 s (−35.5%) | 1,392.3 MB |
| GameCube B | 0.357 s ± 0.015 | 0.718 s ± 0.021 | −0.361 s (−50.3%) | 1,392.3 MB |

#### Compress (ISO → RVZ)

| Disc | rom-weaver | dolphin-tool | Time change | rom-weaver | dolphin | Size change |
| --- | --- | --- | --- | --- | --- | --- |
| GameCube A | 0.273 s ± 0.018 | 0.340 s ± 0.004 | −0.067 s (−19.7%) | 103.4 MB | 103.9 MB | −0.48% |
| GameCube B | 0.269 s ± 0.014 | 0.363 s ± 0.008 | −0.094 s (−25.9%) | 156.9 MB | 156.9 MB | +0.01% |

Times here are sub-second because most of a GameCube disc is pseudorandom padding
that RVZ stores as a seed rather than compressing; only the real payload —
roughly 100–160 MB of a 1.46 GB disc — reaches the compressor.

Both directions are lossless: extracting either tool's RVZ reproduces the source
ISO's SHA-1 exactly, and the two extracted ISOs are byte-identical to each other.

GameCube A measured +8.38% before #213, which changed junk detection to read the
GameCube filesystem table for file end offsets.

### 7z vs 7zz

LZMA2 at level 5 on both sides. The compress inputs are cartridge ROMs, 16 MB to
1 GiB; disc images are excluded because they are what the `chd` and `rvz` suites
measure. The `.7z` archives read back on the extract side do contain disc images.

#### Compress

| Input | Input size | rom-weaver | 7zz | Time change | rom-weaver | 7zz | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GBA ROM `.gba` | 16 MB | 0.944 s ± 0.010 | 0.970 s ± 0.009 | −0.026 s (−2.7%) | 5.5 MB | 5.5 MB | +0.16% |
| GBA ROM (romhack) `.gba` | 32 MB | 2.029 s ± 0.007 | 2.086 s ± 0.012 | −0.057 s (−2.7%) | 9.7 MB | 9.7 MB | +0.09% |
| DS ROM `.nds` | 256 MB | 9.300 s ± 0.263 | 9.200 s ± 0.042 | +0.100 s (+1.1%) | 61.0 MB | 61.0 MB | +0.01% |
| 3DS ROM `.cci` | 1 GiB | 14.721 s ± 0.130 | 14.677 s ± 0.113 | +0.044 s (+0.3%) | 315.5 MB | 315.5 MB | +0.00% |

Both sides now run the same encoder — 7-Zip's LZMA SDK with its own block
multithreading — so time and size land on top of each other. The 1 GiB row is
where the change is largest: it was +140.7% against liblzma's seeded parallel
blocks, and the whole of that premium was the seed indexing each worker did
before it could encode. The SDK resets the dictionary at block boundaries the
way 7zz does, which is what the remaining size difference (at most +0.16%, on
the smallest input) buys back.

`ROM_WEAVER_7Z_ENCODER=liblzma` still selects the seeded liblzma encoder, which
is the row above in reverse: slower than 7zz, and a few tenths of a percent
smaller.

#### Extract

| Input | Input size | rom-weaver | 7zz | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| GameCube A `.7z` | 77 MB | 2.445 s ± 0.006 | 2.527 s ± 0.025 | −0.083 s (−3.3%) | 227.4 MB |
| PS1 CD A `.7z` (8 tracks) | 287 MB | 3.284 s ± 0.010 | 10.084 s ± 0.041 | −6.801 s (−67.4%) | 515.4 MB |
| 3DS ROM `.7z` | 297 MB | 9.120 s ± 0.027 | 9.551 s ± 0.270 | −0.431 s (−4.5%) | 1,024.0 MB |
| PS1 CD C `.7z` | 458 MB | 13.557 s ± 0.199 | 13.760 s ± 0.381 | −0.204 s (−1.5%) | 657.2 MB |
| GD-ROM B `.7z` | 673 MB | 20.539 s ± 0.034 | 20.072 s ± 0.172 | +0.468 s (+2.3%) | 1,134.7 MB |

Every extract is byte-exact against 7zz's. PS1 CD A is the only multi-member
archive in this set — eight track files, which rom-weaver decodes in parallel and
7zz does not; the other four each hold a single file and are a straight
coder-speed comparison.

The single-member rows were +29% to +36% before the SDK swap. Nearly all of that
gap was the decode loop itself: the SDK's C decoder is no faster than liblzma's,
but its hand-written arm64 loop (`LzmaDecOpt.S`) — which is what `7zz` runs —
is. **x86-64 does not get that win**: the SDK only ships the optimised loop in
MASM syntax there, so those builds keep the C decoder and stay roughly where the
old rows were.

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

#### Compress

| Input | Input size | rom-weaver | zip | Time change | rom-weaver | zip | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GBA ROM `.gba` | 16 MB | 0.392 s ± 0.003 | 0.424 s ± 0.002 | −0.032 s (−7.5%) | 6.7 MB | 6.7 MB | −0.03% |
| GBA ROM (romhack) `.gba` | 32 MB | 0.746 s ± 0.002 | 0.828 s ± 0.011 | −0.083 s (−10.0%) | 11.8 MB | 11.8 MB | −0.01% |
| DS ROM `.nds` | 256 MB | 6.197 s ± 0.049 | 7.683 s ± 1.429 | −1.487 s (−19.3%) | 105.8 MB | 105.9 MB | −0.10% |
| 3DS ROM `.cci` | 1 GiB | 16.451 s ± 1.119 | 19.924 s ± 1.868 | −3.473 s (−17.4%) | 373.9 MB | 373.8 MB | +0.02% |

Info-ZIP's spread on the two largest compress inputs (± 1.4 s and ± 1.9 s) is
wide enough that those two percentages are not precise.

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

All four tasks wrap one script, which can be called directly for anything they
do not expose:

```bash
node scripts/bench-disc-tools.mjs --suite rvz --corpus /path/to/corpus --runs 5
```

The corpus is deliberately not in the repository: these benchmarks need real ROMs
and disc images, which are not redistributable. Point `--corpus` (or
`BENCH_CORPUS`) at a directory of your own. The harness discovers sources up to
three levels deep, so the usual one-directory-per-title layout works as-is, and
each suite picks up only what it can use:

| Suite | Reference | Compress inputs | Extract inputs |
| --- | --- | --- | --- |
| `chd` | `chdman` | `.cue` | `.chd` |
| `rvz` | `dolphin-tool` | `.iso`, `.gcm` | `.rvz` |
| `7z` | `7zz` | ROM files | `.7z` |
| `zip` | `zip` / `unzip` | ROM files | `.zip` |

"ROM files" means `.gba`, `.nds`, `.3ds`, `.cci`, `.sfc`, `.smc`, `.n64`,
`.z64`, `.nes`, `.gb`, `.gbc` — cartridge dumps, which range from a 128 KB NES
ROM to a 1 GiB 3DS image. Some of the larger ones only exist inside the corpus's
own archives; extract those once and the archive suites pick them up.

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

`report-<suite>.json` records the host CPU, the rom-weaver version, the reference
tool, the run counts, and for every case both tools' timings and output sizes.

A source one tool declines is recorded as a skip and the run continues.
