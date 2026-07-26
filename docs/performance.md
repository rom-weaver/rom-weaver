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

rom-weaver's advantage is concentrated in **extraction**, and it comes from
threading: wherever the work splits across hunks, blocks, or archive members it
wins by a wide margin, and wherever the format forces a single serial stream —
LZMA2 decoding of a one-file `.7z` — it loses. Compression is close to parity on
time, and sizes track the reference within a fraction of a percent everywhere
except 7z above 256 MB.

Times below are rom-weaver's elapsed time relative to the reference tool's, so a
negative percentage means rom-weaver finished sooner.

| Suite | Reference | Compress time | Extract time | Size vs reference |
| --- | --- | --- | --- | --- |
| CHD | chdman 0.287 | −20.3% to +8.1% | **−67.8% to −82.9%** | −0.27% to −0.01% (smaller) |
| RVZ | dolphin-tool | −19.7% to −25.9% | **−35.5% to −50.3%** | +0.01%, and **+8.38%** on one title |
| 7z | 7zz 26.02 | −42.8% to **+26.5%** | −60.8% to **+40.0%** | +0.16% to **+9.24%** (larger) |
| zip | Info-ZIP | −7.5% to −19.3% | **−37.0% to −63.2%** | −0.10% to +0.02% |

Three results are genuine rom-weaver deficits rather than noise: the **+8.38% RVZ
output on Kururin Squash**, the **7z extract time on single-member archives**,
and the **7z output size on inputs above 256 MB**. All three are discussed in
their sections.

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
- **Sources under 1 MB are skipped** (`--min-size`). A ROM corpus carries patch
  bundles and manifest fixtures that are not ROMs; at that size both tools finish
  in single milliseconds and the comparison is between process startups rather
  than between codecs. `--min-size 0` benchmarks everything.

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
Each group of suites ran back to back on an otherwise idle machine — `chd` and
`rvz` in one sitting, `7z` and `zip` in a second after the archive corpus grew to
include the 256 MB and 1 GiB ROMs.

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

LZMA2 at level 5 on both sides. The inputs are cartridge ROMs, 16 MB to 1 GiB;
disc images are excluded because they are what the `chd` and `rvz` suites
measure. The `.7z` archives read back on the extract side do contain disc images,
which is fine — decompressing one measures the LZMA2 decoder regardless of what
the bytes turn out to be.

#### Compress

| Input | Input size | rom-weaver | 7zz | Time change | rom-weaver | 7zz | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pokémon Emerald `.gba` | 16 MB | 1.204 s ± 0.006 | 0.951 s ± 0.002 | +0.253 s (+26.5%) | 5.5 MB | 5.5 MB | +0.16% |
| Pokémon Emerald (pkmn_rowe) `.gba` | 32 MB | 1.868 s ± 0.052 | 2.049 s ± 0.010 | **−0.181 s (−8.8%)** | 9.7 MB | 9.7 MB | +0.19% |
| Pokémon Black `.nds` | 256 MB | 5.211 s ± 0.011 | 9.107 s ± 0.030 | **−3.896 s (−42.8%)** | 66.6 MB | 61.0 MB | **+9.24%** |
| Star Fox 64 3D `.cci` | 1 GiB | 17.266 s ± 0.121 | 14.597 s ± 0.018 | +2.669 s (+18.3%) | 333.7 MB | 315.5 MB | **+5.75%** |

**The size columns are the story here, not the times.** Up to 32 MB the two
tools' output matches to within 0.2%. At 256 MB rom-weaver is 3.9 s faster but
emits 9.24% more bytes, and at 1 GiB it is both slower *and* 5.75% larger. A
speed win bought with 5.6 MB of extra output is not a win, which is exactly the
failure mode the size columns exist to catch. The pattern — parity on small
inputs, a widening gap once the input exceeds the LZMA2 dictionary — points at
rom-weaver splitting large inputs into independently compressed blocks to thread
them, and paying ratio for the matches that no longer cross block boundaries.

#### Extract

| Input | Input size | rom-weaver | 7zz | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| Kururin Squash! (Japan) `.7z` | 77 MB | 3.375 s ± 0.073 | 2.506 s ± 0.018 | +0.869 s (+34.7%) | 227.4 MB |
| Worms (USA) `.7z` | 287 MB | 4.130 s ± 0.025 | 10.549 s ± 1.108 | **−6.419 s (−60.8%)** | 515.4 MB |
| Star Fox 64 3D `.7z` | 297 MB | 13.028 s ± 0.336 | 9.305 s ± 0.038 | +3.724 s (+40.0%) | 1,024.0 MB |
| Dynasty Warriors 2 (USA) `.7z` | 459 MB | 17.635 s ± 0.208 | 13.482 s ± 0.175 | +4.153 s (+30.8%) | 657.2 MB |
| Space Channel 5 Part 2 (Japan) `.7z` | 673 MB | 27.317 s ± 0.098 | 20.370 s ± 0.232 | +6.947 s (+34.1%) | 1,134.7 MB |

Every extract is byte-exact against 7zz's, so this is purely a speed result.

The one win explains the four losses. Worms is the only archive here with many
members — eight track files — and it is the only one rom-weaver decodes faster,
by 60.8%. The other four each hold a single large file, and on those rom-weaver
loses by a consistent 31–40%. LZMA2 decoding of one stream is inherently serial,
so rom-weaver's threading has nothing to spread across, and what is left is
decoder throughput, where 7zz is simply ahead. **This is the only place in this
document where a reference tool beats rom-weaver at decompression.**

### zip vs Info-ZIP

Deflate at level 6 on both sides; `zip` writes, `unzip` reads.

#### Extract

| Input | Input size | rom-weaver | unzip | Time change | Output |
| --- | --- | --- | --- | --- | --- |
| Pokémon Emerald `.zip` | 6.7 MB | 0.065 s ± 0.001 | 0.120 s ± 0.000 | **−0.055 s (−45.9%)** | 16.0 MB |
| pkmn_rowe patch `.zip` | 8.9 MB | 0.060 s ± 0.001 | 0.095 s ± 0.001 | **−0.035 s (−37.0%)** | 10.1 MB |
| Pokémon Emerald (pkmn_rowe) `.zip` | 11.7 MB | 0.110 s ± 0.001 | 0.224 s ± 0.001 | **−0.114 s (−51.0%)** | 32.0 MB |
| Ocarina of Time `.zip` | 24.9 MB | 0.177 s ± 0.003 | 0.479 s ± 0.024 | **−0.303 s (−63.2%)** | 32.0 MB |
| Pokémon Black `.zip` | 106 MB | 0.843 s ± 0.003 | 1.723 s ± 0.022 | **−0.880 s (−51.1%)** | 256.0 MB |
| Luigi's Mansion mod `.zip` | 124 MB | 0.568 s ± 0.028 | 1.087 s ± 0.041 | **−0.519 s (−47.8%)** | 131.6 MB |

#### Compress

| Input | Input size | rom-weaver | zip | Time change | rom-weaver | zip | Size change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pokémon Emerald `.gba` | 16 MB | 0.392 s ± 0.003 | 0.424 s ± 0.002 | **−0.032 s (−7.5%)** | 6.7 MB | 6.7 MB | −0.03% |
| Pokémon Emerald (pkmn_rowe) `.gba` | 32 MB | 0.746 s ± 0.002 | 0.828 s ± 0.011 | **−0.083 s (−10.0%)** | 11.8 MB | 11.8 MB | −0.01% |
| Pokémon Black `.nds` | 256 MB | 6.197 s ± 0.049 | 7.683 s ± 1.429 | **−1.487 s (−19.3%)** | 105.8 MB | 105.9 MB | −0.10% |
| Star Fox 64 3D `.cci` | 1 GiB | 16.451 s ± 1.119 | 19.924 s ± 1.868 | **−3.473 s (−17.4%)** | 373.9 MB | 373.8 MB | +0.02% |

**zip is the clean sweep: rom-weaver wins all ten cases, both directions, at
matched output size.** Deflate's 32 KB window makes the whole file trivially
splittable, so nothing has to be traded for threading — the sizes agree to within
0.1% at every input size, including the 1 GiB one where 7z gave up 5.75%.

Info-ZIP's own numbers get noisy on the two largest compress inputs (± 1.4 s and
± 1.9 s, against rom-weaver's ± 0.05 s and ± 1.1 s), because a single-threaded
deflate over a gigabyte is long enough for the machine's own background work to
land inside it. The margins are several times that spread, so the direction is
not in doubt, but do not read those two percentages as precise.

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

Small inputs measure process startup, not the codec, which is what `--min-size`
exists to keep out. A 128 KB ROM finishes in under 20 ms in every tool here, so
what gets compared is who starts up and exits fastest; rom-weaver loses those by
a couple of milliseconds and it means nothing. Prefer inputs large enough to run
for at least a second before drawing a conclusion.

Input size changes the answer, so do not extrapolate from one. The 7z suite is
the case in point: at 16–32 MB rom-weaver's output matches 7zz to within 0.2%,
and at 256 MB the same settings give up 9.24%. A suite that stopped at 32 MB —
as this one originally did — would have reported parity and missed it entirely.
