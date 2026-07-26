# Performance

How rom-weaver is benchmarked, what the numbers currently are, and how to
reproduce them.

Every format is measured against the tool that defines it, in both directions —
compress and extract — with output size recorded next to every timing, because a
compress that wins on speed by compressing less has not won.

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
- [Reading the numbers](#reading-the-numbers)

<!-- END doctoc -->

## Summary

rom-weaver's advantage is concentrated in **extraction**, where the reference
tools are single-threaded and it is not. Compression is close to parity: it wins
some, loses some, and sizes track the reference within a fraction of a percent
almost everywhere.

Times below are rom-weaver's elapsed time relative to the reference tool's, so a
negative percentage means rom-weaver finished sooner.

| Suite | Reference | Compress time | Extract time | Size vs reference |
| --- | --- | --- | --- | --- |
| CHD | chdman 0.287 | −20.3% to +8.1% | **−67.8% to −82.9%** | −0.27% to −0.01% (smaller) |
| RVZ | dolphin-tool | −19.7% to −25.9% | **−35.5% to −50.3%** | +0.01%, and **+8.38%** on one title |
| 7z | 7zz 26.02 | −14.0% to **+30.8%** | **+29.9%** | +0.16% to +1.87% (larger) |
| zip | Info-ZIP | −9.0% to **+40.0%** | **−42.0% to −52.2%** | −0.03% to **+9.39%** |

Two results are genuine rom-weaver deficits rather than noise: the **+8.38% RVZ
output on Kururin Squash** and the **+29.9% 7z extract time**. Both are discussed
in their sections.

## Benchmarks in this repository

| Harness | What it measures | Command |
| --- | --- | --- |
| `scripts/bench-disc-tools.mjs` | rom-weaver vs the reference tool for CHD, RVZ, 7z, and zip, compress and extract, timed by [hyperfine](https://github.com/sharkdp/hyperfine) | `mise run bench-chd`, `bench-rvz`, `bench-7z`, `bench-zip` |
| `scripts/bench-command-paths.py` | Elapsed time, peak RSS, and throughput across every CLI command path | `python3 scripts/bench-command-paths.py` |
| `scripts/bench-checksum-threading.py` | Checksum scaling from one thread to many | `python3 scripts/bench-checksum-threading.py` |
| `packages/rom-weaver-webapp/tests/wasm/*.bench.mjs` | Browser WASM worker-client and checksum threading | `npm --prefix packages/rom-weaver-webapp run test:browser:wasm` |

`scripts/parity-check.mjs` is the correctness counterpart: it checks that
rom-weaver's CHD output round-trips through chdman and its RVZ output through
dolphin-tool, and vice versa. Run it before trusting any performance change,
because the fastest way to lose to a reference tool is to stop matching it.

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
command, so the size and the timing describe the same work.

### Settings

Where two tools already agree on a default, both are left alone; where they do
not, both are pinned to the *reference* tool's own default, so the comparison
cannot be tilted toward rom-weaver.

| Suite | rom-weaver | Reference | Note |
| --- | --- | --- | --- |
| CHD | defaults | `chdman createcd` defaults | Both already select `cdlz,cdzl,cdfl` and use every core |
| RVZ | `--codec zstd:5` | `-c zstd -l 5 -b 131072` | Dolphin's suggested RVZ settings; rom-weaver's block size is already 128 KiB (`RVZ_DEFAULT_CHUNK_SIZE`) |
| 7z | `--codec lzma2:5` | `-t7z -m0=lzma2 -mx=5 -mmt=on` | LZMA2 at 7-Zip's default level |
| zip | `--codec deflate:6` | `zip -6` | Deflate at Info-ZIP's default level |

Two further fairness details:

- **Archive extraction is capped at one layer.** rom-weaver unpacks archives
  found inside archives; `7zz` and `unzip` stop after one. The harness passes
  `--no-nested-extract` so both sides do the same work.
- **The zip suite uses two reference binaries**, `zip` to write and `unzip` to
  read, since Info-ZIP splits them.

### Two chdman behaviors the harness works around

Both will bite anyone writing their own comparison:

- **Extraction is split across subcommands by disc type, and chdman picks none
  of them for you.** `extractcd` handles CD and GD-ROM, `extractdvd` handles
  DVD. The harness reads the CHD's own metadata tag via `chdman info`
  (`CHT2`/`CHTR` → CD, `CHGD` → GD-ROM, `DVD ` → DVD) and routes accordingly.
  rom-weaver reads the same tag itself, which is why its side is one command for
  all three.
- **A wrong subcommand fails but still exits 0.** `chdman extractcd` against a
  DVD CHD terminates on an uncaught C++ exception, writes nothing, and returns
  success. Exit status alone would score that crash as an extremely fast run —
  in the first draft of this harness it came out as 0.07 s against rom-weaver's
  5.73 s. Every measured command is therefore also required to produce a
  non-empty output.

## Results

Measured 2026-07-26 on an Apple M1 Max with rom-weaver 0.8.0 built `--release`,
against chdman 0.287, dolphin-tool, 7zz 26.02, and Info-ZIP. Three timed runs
per command after one warmup; `±` is the standard deviation across those runs.
All four suites ran back to back on an otherwise idle machine.

Time change is rom-weaver's elapsed time minus the reference tool's, in seconds
and as a percentage of the reference, so negative means rom-weaver finished
sooner. Size change is rom-weaver's output relative to the reference's, so
negative means smaller.

### CHD vs chdman

Five commercial discs spanning all three CHD disc types, so the numbers are not a
single-format result: PS1 CDs with mixed data and audio tracks (`CHT2`), a
Dreamcast GD-ROM (`CHGD`), and a PS2 DVD (`DVD `).

#### Extract

| Disc | Type | rom-weaver | chdman | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| Worms (USA) | CD | 1.516 s ± 0.011 | 7.517 s ± 0.023 | **−6.001 s (−79.8%)** | 515.4 MB |
| Crash Bandicoot (USA) | CD | 2.021 s ± 0.008 | 11.807 s ± 0.026 | **−9.786 s (−82.9%)** | 602.8 MB |
| Dynasty Warriors 2 (USA) | CD | 2.967 s ± 0.018 | 16.074 s ± 0.033 | **−13.107 s (−81.5%)** | 657.2 MB |
| Sonic Adventure 2 (USA) | GD-ROM | 5.394 s ± 0.096 | 27.031 s ± 0.032 | **−21.637 s (−80.0%)** | 1,145.4 MB |
| Ape Escape 2 (USA) | DVD | 5.726 s ± 0.062 | 17.766 s ± 0.034 | **−12.040 s (−67.8%)** | 1,697.8 MB |

The gap is threading: chdman decompresses hunks on one core, so its extract runs
at roughly 100% CPU while rom-weaver's runs at several hundred. The DVD case is
the narrowest of the five because a DVD CHD has no per-track subcode or audio
work to spread out.

Both tools reconstruct the same image. Sizes agree to within 72 bytes on every
disc, and that difference is entirely cue-sheet text — track naming and line
endings — not image data.

#### Compress

| Disc | Type | rom-weaver | chdman | Time change | rom-weaver | chdman | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Worms (USA) | CD | 9.080 s ± 0.485 | 8.402 s ± 0.032 | +0.678 s (+8.1%) | 243.7 MB | 244.4 MB | **−0.27%** |
| Dynasty Warriors 2 (USA) | CD | 13.887 s ± 0.087 | 15.110 s ± 0.081 | **−1.223 s (−8.1%)** | 419.2 MB | 419.5 MB | −0.07% |
| Space Channel 5 Part 2 (Japan) | GD-ROM | 13.855 s ± 0.085 | 17.382 s ± 0.048 | **−3.527 s (−20.3%)** | 646.8 MB | 646.8 MB | −0.01% |
| Sonic Adventure 2 (USA) | GD-ROM | 15.712 s ± 0.161 | 18.675 s ± 0.364 | **−2.963 s (−15.9%)** | 872.2 MB | 872.3 MB | −0.01% |

Compression is close, which is expected: both tools saturate every core in the
same LZMA-dominated codec set, so there is no threading gap to exploit and what
remains is the compressor itself. rom-weaver wins three of four and loses Worms
by 0.678 s (8.1%).

rom-weaver's output is smaller on all four. The margins are too small to claim a
compression-ratio win, but they rule out the failure mode the size columns exist
to catch: none of the speed above was bought by compressing less. Note when
reading these numbers that rom-weaver's default is `--level max`, its hardest
setting.

### RVZ vs dolphin-tool

Two GameCube titles. The `.rvz` sources are third-party dumps; the `.iso`
compress inputs were produced by extracting them.

#### Extract (RVZ → ISO)

| Disc | rom-weaver | dolphin-tool | Time change | Output |
| --- | --- | --- | --- | --- |
| Kururin Squash! (Japan) | 0.350 s ± 0.013 | 0.543 s ± 0.023 | **−0.193 s (−35.5%)** | 1,392.3 MB |
| Luigi's Mansion (USA) | 0.357 s ± 0.015 | 0.718 s ± 0.021 | **−0.361 s (−50.3%)** | 1,392.3 MB |

#### Compress (ISO → RVZ)

| Disc | rom-weaver | dolphin-tool | Time change | rom-weaver | dolphin | Size change |
| --- | --- | --- | --- | --- | --- | --- |
| Kururin Squash! (Japan) | 0.273 s ± 0.018 | 0.340 s ± 0.004 | **−0.067 s (−19.7%)** | 112.6 MB | 103.9 MB | **+8.38%** |
| Luigi's Mansion (USA) | 0.269 s ± 0.014 | 0.363 s ± 0.008 | **−0.094 s (−25.9%)** | 156.9 MB | 156.9 MB | +0.01% |

The sub-second times are not a mistake, and they are why these numbers are not
comparable to the CHD ones. Most of a GameCube disc is pseudorandom padding, and
RVZ's whole purpose is to recognise that padding and store a seed for it instead
of compressing it. Only the real payload — roughly 100–160 MB of a 1.46 GB
disc — reaches the compressor, so an RVZ compress is dominated by scanning
rather than by zstd.

Both directions are lossless. Extracting either tool's RVZ reproduces the source
ISO's SHA-1 exactly (`f1e5e507…` for Kururin), and the two extracted ISOs are
byte-identical to each other.

**The size gap on Kururin Squash is a real rom-weaver regression**, not a
measurement artifact: at identical codec, level, and block size, rom-weaver emits
8.4% more bytes. Luigi's Mansion comes out even (+0.01%), so this is not a
general ratio deficit — it points at junk-region detection on that particular
disc, where rom-weaver evidently recognises less padding than dolphin-tool does.
It costs size only, not correctness.

### 7z vs 7zz

LZMA2 at level 5 on both sides. Disc images are deliberately excluded from the
archive suites: an LZMA2 pass over a 1.5 GB ISO runs for minutes and says more
about the disc than about the archiver.

#### Compress

| Input | Input size | rom-weaver | 7zz | Time change | rom-weaver | 7zz | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Zelda (PRG0) `.nes` | 128 KB | 0.017 s ± 0.001 | 0.013 s ± 0.001 | +0.004 s (+30.8%) | 60.0 KB | 58.9 KB | +1.87% |
| Pokémon Emerald `.gba` | 16 MB | 1.250 s ± 0.017 | 0.965 s ± 0.011 | +0.285 s (+29.5%) | 5.5 MB | 5.5 MB | +0.16% |
| Pokémon Emerald (pkmn_rowe) `.gba` | 32 MB | 1.771 s ± 0.038 | 2.060 s ± 0.004 | **−0.289 s (−14.0%)** | 9.7 MB | 9.7 MB | +0.19% |

#### Extract

| Input | Input size | rom-weaver | 7zz | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| Kururin Squash! (Japan) `.7z` | 77 MB | 3.277 s ± 0.043 | 2.523 s ± 0.014 | +0.754 s (+29.9%) | 227.4 MB |

**7z is the one suite rom-weaver loses outright.** It is slower on both small
inputs and on extract, and its output is consistently a fraction of a percent
larger. Only the 32 MB input goes its way. The extract result is the notable
one: +29.9% is the only place in this document where a reference tool beats
rom-weaver at decompression, and unlike the compress cases it cannot be
explained away by codec tuning — 7zz simply has the faster LZMA2 decoder here.

### zip vs Info-ZIP

Deflate at level 6 on both sides; `zip` writes, `unzip` reads.

#### Extract

| Input | Input size | rom-weaver | unzip | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| Ocarina of Time `.zip` | 25 MB | 0.160 s ± 0.000 | 0.276 s ± 0.001 | **−0.116 s (−42.0%)** | 32.0 MB |
| Pokémon Black `.zip` | 106 MB | 0.793 s ± 0.004 | 1.660 s ± 0.004 | **−0.867 s (−52.2%)** | 256.0 MB |

#### Compress

| Input | Input size | rom-weaver | zip | Time change | rom-weaver | zip | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Zelda (PRG0) `.nes` | 128 KB | 0.007 s ± 0.000 | 0.005 s ± 0.000 | +0.002 s (+40.0%) | 70.0 KB | 64.0 KB | **+9.39%** |
| Pokémon Emerald `.gba` | 16 MB | 0.374 s ± 0.001 | 0.411 s ± 0.004 | **−0.037 s (−9.0%)** | 6.7 MB | 6.7 MB | −0.03% |
| Pokémon Emerald (pkmn_rowe) `.gba` | 32 MB | 0.733 s ± 0.024 | 0.787 s ± 0.001 | **−0.054 s (−6.9%)** | 11.8 MB | 11.8 MB | −0.01% |

Deflate favours rom-weaver on anything large enough to thread, in both
directions. The `.nes` row is the exception across both archive suites: at 128 KB
the whole job is process startup, and rom-weaver's fixed overhead is the larger
share of it — the +40.0% there is 2 ms. The +9.39% on that same row is 6 KB in
absolute terms — real, but a
small-file constant rather than a ratio deficit, and it is gone by 16 MB.

## Reproducing

```bash
cargo build --release -p rom-weaver-cli
npm install --global chdman dolphin-tool   # or your distribution's packages
brew install hyperfine sevenzip            # zip/unzip ship with macOS

BENCH_CORPUS=~/roms mise run bench-chd
BENCH_CORPUS=~/roms mise run bench-rvz
BENCH_CORPUS=~/roms mise run bench-7z
BENCH_CORPUS=~/roms mise run bench-zip
```

All four tasks wrap one script, which can be called directly for anything they
do not expose:

```bash
node scripts/bench-disc-tools.mjs --suite rvz --corpus ~/roms --runs 5
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

"ROM files" means `.gba`, `.nds`, `.sfc`, `.smc`, `.n64`, `.z64`, `.nes`, `.gb`,
`.gbc`.

Flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--suite <chd\|rvz\|7z\|zip>` | `chd` | Which format and reference tool to benchmark |
| `--corpus <dir>` | required | Directory of ROMs or disc images |
| `--out <dir>` | `dist/bench/disc-tools` | Where `report-<suite>.json` and the per-case hyperfine JSON land |
| `--cases compress,extract` | both | Restrict to one direction |
| `--runs <n>` | 3 | Measured runs per command |
| `--warmup <n>` | 1 | Warmup runs per command |
| `--rom-weaver-bin <path>` | `target/release/rom-weaver` | Binary under test |
| `--reference-bin <path>` | per suite | Reference binary |

`report-<suite>.json` records the host CPU, the rom-weaver version, the reference
tool, the run counts, and for every case both tools' timings and output sizes —
enough to compare two runs without rerunning the first.

A source one tool declines is recorded as a skip and the run continues, so a
heterogeneous corpus does not cost you the whole run.

## Reading the numbers

Benchmark on a quiet machine. The disc workloads are wide — both sides saturate
every core — so anything else compiling or indexing shows up directly in the
mean. It is visible when it happens: an early draft of the CHD run overlapped
with another benchmark, and on the same case the standard deviation grew sixfold
between runs while the mean barely moved. Treat a spread that large as a rerun,
not a result.

Disc images are big enough that the page cache matters. The warmup run exists to
get the source into cache so the measured runs compare compression work rather
than first-read disk latency. On a machine without room to cache the whole source
the numbers describe an I/O-bound workload instead, and the tools converge.

Small inputs measure process startup, not the codec. The 128 KB `.nes` rows in
the archive suites are the clearest case: every tool finishes in under 20 ms, so
what is being compared is who starts up and exits fastest. Prefer inputs large
enough to run for at least a second before drawing a conclusion.
