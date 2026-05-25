#!/usr/bin/env python3
"""Benchmark checksum threading crossover points.

Runs `rom-weaver checksum` for standalone algorithms across size buckets, comparing
single-thread versus multi-thread execution, and emits both machine-readable JSON
and a concise summary table.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

MIB = 1024 * 1024


@dataclass
class SampleRow:
    algorithm: str
    size_mib: int
    threads: int
    p50_s: float
    p90_s: float
    all_s: list[float]


@dataclass
class SpeedupRow:
    algorithm: str
    size_mib: int
    p50_speedup: float
    p90_speedup: float


def parse_int_list(raw: str) -> list[int]:
    values: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        values.append(int(part))
    if not values:
        raise ValueError("expected at least one integer value")
    return values


def parse_str_list(raw: str) -> list[str]:
    values = [part.strip() for part in raw.split(",") if part.strip()]
    if not values:
        raise ValueError("expected at least one value")
    return values


def percentile(values: list[float], p: float) -> float:
    if not values:
        raise ValueError("cannot compute percentile of empty sequence")
    if len(values) == 1:
        return values[0]
    ordered = sorted(values)
    rank = (len(ordered) - 1) * p
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    frac = rank - lo
    return ordered[lo] * (1.0 - frac) + ordered[hi] * frac


def ensure_fixture(path: Path, min_bytes: int) -> None:
    if path.exists() and path.stat().st_size >= min_bytes:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    pattern = bytes((i % 251 for i in range(MIB)))
    with path.open("wb") as handle:
        remaining = min_bytes
        while remaining > 0:
            chunk = pattern[: min(remaining, len(pattern))]
            handle.write(chunk)
            remaining -= len(chunk)


def build_if_needed(bin_path: Path) -> None:
    if bin_path.exists():
        return
    subprocess.run(
        ["cargo", "build", "-p", "rom-weaver-cli"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def run_once(
    bin_path: Path,
    source_path: Path,
    algorithm: str,
    size_bytes: int,
    start_bytes: int,
    threads: int,
) -> float:
    cmd = [
        str(bin_path),
        "checksum",
        "--algo",
        algorithm,
        "--threads",
        str(threads),
        "--no-extract",
        "--start",
        str(start_bytes),
        "--length",
        str(size_bytes),
        str(source_path),
    ]
    env = os.environ.copy()
    with tempfile.TemporaryDirectory(prefix="rw-checksum-bench-") as tmpdir:
        env["TMPDIR"] = tmpdir
        t0 = time.perf_counter()
        result = subprocess.run(
            cmd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        elapsed = time.perf_counter() - t0
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}")
    return elapsed


def gather_samples(
    *,
    bin_path: Path,
    source_path: Path,
    algorithms: list[str],
    sizes_mib: list[int],
    sequential_threads: int,
    parallel_threads: int,
    trials: int,
    warmups: int,
    stride_mib: int,
) -> list[SampleRow]:
    rows: list[SampleRow] = []
    stride_bytes = stride_mib * MIB

    for algorithm in algorithms:
        for size_mib in sizes_mib:
            size_bytes = size_mib * MIB
            for threads in (sequential_threads, parallel_threads):
                phase_offset = 0 if threads == sequential_threads else stride_bytes // 2
                for trial in range(warmups):
                    _ = run_once(
                        bin_path,
                        source_path,
                        algorithm,
                        size_bytes,
                        trial * stride_bytes + phase_offset,
                        threads,
                    )

                samples: list[float] = []
                for trial in range(trials):
                    start = (trial + warmups) * stride_bytes + phase_offset
                    samples.append(
                        run_once(
                            bin_path,
                            source_path,
                            algorithm,
                            size_bytes,
                            start,
                            threads,
                        )
                    )

                rows.append(
                    SampleRow(
                        algorithm=algorithm,
                        size_mib=size_mib,
                        threads=threads,
                        p50_s=statistics.median(samples),
                        p90_s=percentile(samples, 0.9),
                        all_s=samples,
                    )
                )
    return rows


def build_speedups(rows: Iterable[SampleRow], sequential_threads: int, parallel_threads: int) -> list[SpeedupRow]:
    keyed: dict[tuple[str, int, int], SampleRow] = {
        (row.algorithm, row.size_mib, row.threads): row for row in rows
    }
    speedups: list[SpeedupRow] = []

    keys = sorted({(row.algorithm, row.size_mib) for row in rows})
    for algorithm, size_mib in keys:
        seq = keyed[(algorithm, size_mib, sequential_threads)]
        par = keyed[(algorithm, size_mib, parallel_threads)]
        speedups.append(
            SpeedupRow(
                algorithm=algorithm,
                size_mib=size_mib,
                p50_speedup=seq.p50_s / par.p50_s,
                p90_speedup=seq.p90_s / par.p90_s,
            )
        )
    return speedups


def recommend_crossover(
    speedups: Iterable[SpeedupRow],
    min_p50_gain: float,
    min_p90_gain: float,
) -> dict[str, int | None]:
    recs: dict[str, int | None] = {}
    grouped: dict[str, list[SpeedupRow]] = {}
    for row in speedups:
        grouped.setdefault(row.algorithm, []).append(row)

    for algorithm, rows in grouped.items():
        rows.sort(key=lambda row: row.size_mib)
        rec: int | None = None
        for row in rows:
            if row.p50_speedup >= min_p50_gain and row.p90_speedup >= min_p90_gain:
                rec = row.size_mib
                break
        recs[algorithm] = rec
    return recs


def print_summary(speedups: list[SpeedupRow], recommendations: dict[str, int | None]) -> None:
    print("\nSpeedup Summary (sequential_time / parallel_time):")
    print("algorithm  size_mib  p50_speedup  p90_speedup")
    print("---------  --------  -----------  -----------")
    for row in sorted(speedups, key=lambda row: (row.algorithm, row.size_mib)):
        print(
            f"{row.algorithm:<9}  {row.size_mib:>8}  {row.p50_speedup:>11.3f}  {row.p90_speedup:>11.3f}"
        )

    print("\nRecommended crossover sizes (MiB):")
    for algorithm in sorted(recommendations):
        value = recommendations[algorithm]
        if value is None:
            print(f"- {algorithm}: no size met policy")
        else:
            print(f"- {algorithm}: {value}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark checksum threading crossover points")
    parser.add_argument(
        "--bin",
        type=Path,
        default=Path("target/debug/rom-weaver"),
        help="Path to rom-weaver binary (default: target/debug/rom-weaver)",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(".tmp/checksum-bench/fixture.bin"),
        help="Path to reusable benchmark fixture file",
    )
    parser.add_argument(
        "--algorithms",
        default="crc32c,crc16,adler32",
        help="Comma-separated algorithms",
    )
    parser.add_argument(
        "--sizes-mib",
        default="8,16,24,32,40,48,64,96",
        help="Comma-separated test sizes in MiB",
    )
    parser.add_argument("--sequential-threads", type=int, default=1)
    parser.add_argument("--parallel-threads", type=int, default=4)
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--stride-mib", type=int, default=2)
    parser.add_argument(
        "--min-p50-gain",
        type=float,
        default=1.10,
        help="Minimum p50 speedup required to recommend crossover",
    )
    parser.add_argument(
        "--min-p90-gain",
        type=float,
        default=1.05,
        help="Minimum p90 speedup required to recommend crossover",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Optional path to write full JSON results",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip automatic cargo build when binary is missing",
    )

    args = parser.parse_args()
    algorithms = parse_str_list(args.algorithms)
    sizes_mib = parse_int_list(args.sizes_mib)

    if not args.skip_build:
        build_if_needed(args.bin)
    elif not args.bin.exists():
        raise SystemExit(f"binary missing and --skip-build set: {args.bin}")

    max_size = max(sizes_mib) * MIB
    # Need headroom for warmups+trials plus two phases.
    stride_bytes = args.stride_mib * MIB
    headroom = (args.warmups + args.trials + 2) * stride_bytes
    ensure_fixture(args.source, max_size + headroom)

    samples = gather_samples(
        bin_path=args.bin,
        source_path=args.source,
        algorithms=algorithms,
        sizes_mib=sizes_mib,
        sequential_threads=args.sequential_threads,
        parallel_threads=args.parallel_threads,
        trials=args.trials,
        warmups=args.warmups,
        stride_mib=args.stride_mib,
    )

    speedups = build_speedups(samples, args.sequential_threads, args.parallel_threads)
    recommendations = recommend_crossover(speedups, args.min_p50_gain, args.min_p90_gain)

    payload = {
        "meta": {
            "bin": str(args.bin),
            "source": str(args.source),
            "algorithms": algorithms,
            "sizes_mib": sizes_mib,
            "sequential_threads": args.sequential_threads,
            "parallel_threads": args.parallel_threads,
            "trials": args.trials,
            "warmups": args.warmups,
            "stride_mib": args.stride_mib,
            "min_p50_gain": args.min_p50_gain,
            "min_p90_gain": args.min_p90_gain,
        },
        "samples": [asdict(row) for row in samples],
        "speedups": [asdict(row) for row in speedups],
        "recommendations_mib": recommendations,
    }

    print_summary(speedups, recommendations)

    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"\nWrote JSON results: {args.json_out}")

    # Always print compact JSON to stdout for automation pipelines.
    print("\nJSON:")
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
