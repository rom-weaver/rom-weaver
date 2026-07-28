#!/usr/bin/env python3
"""Benchmark redundant decode when extracting a solid archive in parallel.

Every extract worker opens its own reader and walks the archive from the start, so on a
solid archive it re-decodes everything before its first assigned entry. The cost is
invisible in wall clock - the workers run concurrently, so the critical path is still one
decode - but it shows up as user CPU, which is what a phone pays for in battery and
thermal throttling.

The metric that matters is *decode amplification*: user CPU at N threads divided by user
CPU at one thread. 1.0 means each byte was decoded once; N means every worker decoded the
whole block. Wall clock is reported but is not the headline - it is far more sensitive to
machine load than the CPU figures are.

Byte-balanced chunking already removes the amplification when one entry dominates (the
Dreamcast GDI shape: a few large tracks plus sub-KB metadata). This measures the case it
cannot help - several similarly-sized large entries in one solid block, where each worker
legitimately gets real work and redundantly decodes to reach it.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import resource
import shutil
import statistics
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

MIB = 1024 * 1024
SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
BENCH_DEFAULTS_PATH = REPO_ROOT / "scripts" / "bench-defaults.json"


def load_benchmark_defaults() -> dict:
    try:
        return json.loads(BENCH_DEFAULTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"failed to load shared benchmark defaults {BENCH_DEFAULTS_PATH}: {error}") from error


BENCH_DEFAULTS = load_benchmark_defaults()
SOLID_EXTRACT_DEFAULTS = BENCH_DEFAULTS["solid_extract"]
FIXTURE_CACHE_DIR = (
    REPO_ROOT / "target" / "bench-fixtures" / f"solid-extract-v{BENCH_DEFAULTS['fixture_cache_version']}"
)


@dataclass
class RunSample:
    threads: str
    wall_s: float
    user_s: float
    sys_s: float
    peak_rss_mib: float


@dataclass
class ThreadResult:
    threads: str
    wall_s: float
    user_s: float
    peak_rss_mib: float
    amplification: float


# Share of blocks repeated from earlier in the stream. Tuned so the fixture lands near the
# ~1.7:1 that real disc images hit (Space Channel 5's GDI: 1189 MiB -> 705 MiB). Repeating a
# single block with mutations instead compresses ~800:1, which makes the decode trivial and
# turns the benchmark into a measurement of process startup.
REPEAT_FRACTION = 0.4
GENERATOR_BLOCK_BYTES = 64 * 1024


def parse_peak_rss_mib(time_output: str) -> float | None:
    """Parse peak RSS out of `/usr/bin/time` output (macOS `-l` bytes, GNU `-v` kilobytes).

    `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss` cannot be used here: it is a monotonic
    high-water mark across every child the process ever reaped, so the fixture-packing run
    pins it and every later extract reports that same number.
    """
    for line in time_output.splitlines():
        stripped = line.strip()
        if stripped.endswith("maximum resident set size"):
            return int(stripped.split()[0]) / MIB
        if "Maximum resident set size" in stripped:
            return int(stripped.rsplit(":", 1)[1].strip()) / 1024
    return None


def generate_entry_bytes(size_bytes: int, seed: int) -> bytes:
    """Build ROM-like data: partly repeated so LZMA finds matches, mostly fresh so it works.

    Emits fresh random blocks interleaved with blocks drawn from earlier in the same stream,
    which gives the dictionary long matches to find without collapsing the whole entry to a
    handful of literals.
    """
    rng = random.Random(seed)
    blocks: list[bytes] = []
    out = bytearray()
    while len(out) < size_bytes:
        if blocks and rng.random() < REPEAT_FRACTION:
            block = blocks[rng.randrange(len(blocks))]
        else:
            block = rng.randbytes(GENERATOR_BLOCK_BYTES)
            blocks.append(block)
        out += block
    return bytes(out[:size_bytes])


def build_fixture(entries: int, entry_mib: int, sevenzip: str) -> Path:
    FIXTURE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    archive = FIXTURE_CACHE_DIR / f"solid-{entries}x{entry_mib}mib.7z"
    if archive.exists():
        print(f"reusing cached fixture {archive} ({archive.stat().st_size / MIB:.1f} MiB)")
        return archive

    staging = FIXTURE_CACHE_DIR / f"staging-{entries}x{entry_mib}mib"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    print(f"generating {entries} x {entry_mib} MiB of ROM-like data ...")
    for index in range(entries):
        (staging / f"track-{index + 1}.bin").write_bytes(generate_entry_bytes(entry_mib * MIB, index + 1))

    # -ms=on forces one solid block across every entry; -mx=6 matches 7-Zip's default level
    # (a 8 MiB dictionary at this size after reduction), which is what real archives use.
    print(f"packing solid archive with {sevenzip} ...")
    completed = subprocess.run(
        [sevenzip, "a", "-t7z", "-ms=on", "-mx=6", "-bso0", "-bsp0", str(archive), "."],
        cwd=staging,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        archive.unlink(missing_ok=True)
        raise SystemExit(f"{sevenzip} failed to build the fixture:\n{completed.stderr.strip()}")
    shutil.rmtree(staging)
    print(f"built {archive} ({archive.stat().st_size / MIB:.1f} MiB)")
    return archive


def verify_solid(archive: Path, sevenzip: str, entries: int) -> None:
    """A non-solid fixture would silently measure nothing - fail loudly instead."""
    listing = subprocess.run(
        [sevenzip, "l", "-slt", str(archive)], capture_output=True, text=True, check=False
    ).stdout
    if "Solid = +" not in listing:
        raise SystemExit(f"{archive} is not solid; the benchmark would measure nothing")
    blocks = next((line.split("=", 1)[1].strip() for line in listing.splitlines() if line.startswith("Blocks =")), "?")
    if blocks != "1":
        raise SystemExit(f"{archive} has {blocks} solid blocks; expected 1 so every worker shares one decode chain")
    print(f"fixture verified: solid, 1 block, {entries} entries")


def time_flag() -> str:
    return "-l" if platform.system() == "Darwin" else "-v"


def run_extract(binary: Path, archive: Path, out_dir: Path, threads: str) -> RunSample:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    command = [
        str(binary), "extract",
        "--input", str(archive),
        "--output", str(out_dir),
        "--force",
        "--threads", threads,
    ]
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = os.times().elapsed
    completed = subprocess.run(
        ["/usr/bin/time", time_flag(), *command], capture_output=True, text=True
    )
    wall = os.times().elapsed - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if completed.returncode != 0:
        raise SystemExit(f"extract failed at --threads {threads}:\n{completed.stderr.strip()}")
    shutil.rmtree(out_dir, ignore_errors=True)
    peak = parse_peak_rss_mib(completed.stderr)
    if peak is None:
        raise SystemExit(f"could not parse peak RSS from /usr/bin/time {time_flag()} output")
    return RunSample(
        threads=threads,
        wall_s=wall,
        # utime/stime accumulate, so the delta over one child is exact - unlike ru_maxrss.
        user_s=after.ru_utime - before.ru_utime,
        sys_s=after.ru_stime - before.ru_stime,
        peak_rss_mib=peak,
    )


def summarise(samples: list[RunSample], baseline_user_s: float) -> ThreadResult:
    user_s = statistics.median(sample.user_s for sample in samples)
    return ThreadResult(
        threads=samples[0].threads,
        wall_s=statistics.median(sample.wall_s for sample in samples),
        user_s=user_s,
        peak_rss_mib=max(sample.peak_rss_mib for sample in samples),
        amplification=user_s / baseline_user_s if baseline_user_s else float("nan"),
    )


def print_table(results: list[ThreadResult]) -> None:
    print()
    print(f"{'threads':>8}  {'wall s':>8}  {'user s':>8}  {'peak MiB':>9}  {'amplification':>14}")
    print(f"{'-' * 8}  {'-' * 8}  {'-' * 8}  {'-' * 9}  {'-' * 14}")
    for result in results:
        print(
            f"{result.threads:>8}  {result.wall_s:>8.2f}  {result.user_s:>8.2f}  "
            f"{result.peak_rss_mib:>9.1f}  {result.amplification:>13.2f}x"
        )
    print()
    print("amplification is user CPU relative to --threads 1: 1.0 = each byte decoded once,")
    print("N = every worker decoded the whole solid block.")


def load_average() -> float | None:
    try:
        return os.getloadavg()[0]
    except (OSError, AttributeError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--entries", type=int, default=SOLID_EXTRACT_DEFAULTS["entries"])
    parser.add_argument("--entry-mib", type=int, default=SOLID_EXTRACT_DEFAULTS["entry_mib"])
    parser.add_argument("--threads", default=SOLID_EXTRACT_DEFAULTS["threads"], help="comma-separated thread counts")
    parser.add_argument("--repeat", type=int, default=SOLID_EXTRACT_DEFAULTS["repeat"])
    parser.add_argument("--binary", type=Path, default=REPO_ROOT / "target" / "release" / "rom-weaver")
    parser.add_argument("--sevenzip", default=SOLID_EXTRACT_DEFAULTS["sevenzip"], help="7-Zip CLI used to pack")
    parser.add_argument("--json", type=Path, help="also write the full results here")
    args = parser.parse_args()

    if not args.binary.is_file():
        raise SystemExit(f"{args.binary} not found; build it with `cargo build -p rom-weaver-cli --release`")
    sevenzip = shutil.which(args.sevenzip)
    if sevenzip is None:
        raise SystemExit(f"`{args.sevenzip}` not found on PATH; it is needed to pack a guaranteed-solid fixture")

    load = load_average()
    if load is not None and load > os.cpu_count():
        print(
            f"WARNING: load average is {load:.1f} on {os.cpu_count()} cores. Wall clock will be unreliable; "
            "user CPU and amplification still hold.",
            file=sys.stderr,
        )

    archive = build_fixture(args.entries, args.entry_mib, sevenzip)
    verify_solid(archive, sevenzip, args.entries)

    thread_settings = [value.strip() for value in args.threads.split(",") if value.strip()]
    if not thread_settings or thread_settings[0] != "1":
        raise SystemExit("--threads must start with 1; it is the amplification baseline")

    out_dir = FIXTURE_CACHE_DIR / "extract-out"
    all_samples: list[RunSample] = []
    results: list[ThreadResult] = []
    baseline_user_s = 0.0
    for threads in thread_settings:
        print(f"running --threads {threads} x{args.repeat} ...")
        samples = [run_extract(args.binary, archive, out_dir, threads) for _ in range(args.repeat)]
        all_samples.extend(samples)
        if not baseline_user_s:
            baseline_user_s = statistics.median(sample.user_s for sample in samples)
        results.append(summarise(samples, baseline_user_s))

    print_table(results)

    if args.json:
        args.json.write_text(
            json.dumps(
                {
                    "fixture": {"entries": args.entries, "entry_mib": args.entry_mib, "archive": str(archive)},
                    "host": {"platform": platform.platform(), "cpus": os.cpu_count(), "load_average": load},
                    "results": [asdict(result) for result in results],
                    "samples": [asdict(sample) for sample in all_samples],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
