#!/usr/bin/env python3
"""Benchmark memory pressure, throughput, and elapsed time across CLI command paths.

This script runs real `rom-weaver` CLI commands and records:
- elapsed wall-clock time
- peak RSS (via `/usr/bin/time`)
- throughput (MiB/s) when processed-byte counts are known

Coverage targets:
- `compress` across all registered container format names
- `extract` for each format with an available valid source artifact
- `checksum` for every supported algorithm (raw bytes) plus container auto-extract inputs
- `patch-create` across all registered patch format names
- `patch-apply` for every format with a valid patch fixture (generated or static)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MIB = 1024 * 1024
TIME_BIN = Path("/usr/bin/time")

CONTAINER_FORMATS = [
    "zip",
    "zipx",
    "7z",
    "rar",
    "tar",
    "tar.gz",
    "tar.bz2",
    "tar.xz",
    "gz",
    "bz2",
    "xz",
    "zst",
    "cso",
    "pbp",
    "chd",
    "gcz",
    "wia",
    "tgc",
    "nfs",
    "wbfs",
    "rvz",
    "z3ds",
    "xiso",
]

CONTAINER_SUFFIX = {
    "tar.gz": "tar.gz",
    "tar.bz2": "tar.bz2",
    "tar.xz": "tar.xz",
}

EXPECTED_COMPRESS_SKIPS = {
    "rar": "intentionally unsupported: rar create is not supported",
    "xiso": "intentionally unsupported: xiso is trim-only and not a compress format",
    "pbp": "intentionally unsupported: pbp create is not supported",
    "gcz": "intentionally unsupported: gcz compression is not supported (use rvz)",
    "nfs": "intentionally unsupported: nfs compression is not supported",
    "tgc": "benchmark fixture limitation: tgc create requires a full GC disc image with readable DOL",
}

EXPECTED_PATCH_CREATE_SKIPS = {
    "ninja1": "intentionally unsupported: NINJA1 patch creation is not supported",
    "bsp": "intentionally unsupported: BSP patch creation is not implemented",
    "hdiffpatch": "intentionally unsupported: HDiffPatch/HPatchZ patch creation is disabled",
}

DISC_COMPRESS_INPUT_FORMATS = {"rvz", "wia", "wbfs", "tgc"}

DLDI_MAGIC = bytes([0xED, 0xA5, 0x8D, 0xBF, ord(" "), ord("C"), ord("h"), ord("i"), ord("s"), ord("h"), ord("m"), 0x00])
DLDI_VERSION = 1
DLDI_FIX_ALL = 0x01
DLDI_FIX_GLUE = 0x02
DLDI_FIX_GOT = 0x04
DLDI_FIX_BSS = 0x08
DLDI_DO_MAGIC_STRING = 0x00
DLDI_DO_VERSION = 0x0C
DLDI_DO_DRIVER_SIZE = 0x0D
DLDI_DO_FIX_SECTIONS = 0x0E
DLDI_DO_ALLOCATED_SPACE = 0x0F
DLDI_DO_FRIENDLY_NAME = 0x10
DLDI_DO_TEXT_START = 0x40
DLDI_DO_DATA_END = 0x44
DLDI_DO_GLUE_START = 0x48
DLDI_DO_GLUE_END = 0x4C
DLDI_DO_GOT_START = 0x50
DLDI_DO_GOT_END = 0x54
DLDI_DO_BSS_START = 0x58
DLDI_DO_BSS_END = 0x5C
DLDI_DO_STARTUP = 0x68
DLDI_DO_READ_SECTORS = 0x70
DLDI_DO_WRITE_SECTORS = 0x74
DLDI_DO_SHUTDOWN = 0x7C
DLDI_DO_CODE = 0x80
DLDI_SLOT_OFFSET = 0x300
DLDI_SLOT_ALLOCATED_LOG2 = 12
DLDI_SLOT_MEM_OFFSET = 0x0200_0000
DLDI_PATCH_DRIVER_LOG2 = 8
DLDI_PATCH_BASE_ADDRESS = 0xBF80_0000
IPS_CREATE_MAX_INPUT_BYTES = 0x01000000  # IPS family patch-create uses 24-bit offsets.
IPS_EBP_BENCH_MAX_BYTES = IPS_CREATE_MAX_INPUT_BYTES - 1

CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "crc16", "adler32"]

PATCH_FORMATS = [
    "ips",
    "ips32",
    "solid",
    "bps",
    "ups",
    "vcdiff",
    "xdelta",
    "gdiff",
    "hdiffpatch",
    "aps",
    "apsgba",
    "ninja1",
    "rup",
    "ppf",
    "pat",
    "ebp",
    "bdf",
    "bsp",
    "mod",
    "dldi",
    "dps",
]

PATCH_EXTENSION = {
    "ips": "ips",
    "ips32": "ips32",
    "solid": "solid",
    "bps": "bps",
    "ups": "ups",
    "vcdiff": "vcdiff",
    "xdelta": "xdelta",
    "gdiff": "gdiff",
    "hdiffpatch": "hpatchz",
    "aps": "aps",
    "apsgba": "apsgba",
    "ninja1": "n1",
    "rup": "rup",
    "ppf": "ppf",
    "pat": "pat",
    "ebp": "ebp",
    "bdf": "bsdiff",
    "bsp": "bsp",
    "mod": "mod",
    "dldi": "dldi",
    "dps": "dps",
}


@dataclass
class TrialSample:
    elapsed_s: float
    peak_rss_bytes: int | None
    processed_bytes: int | None


@dataclass
class RunOutcome:
    elapsed_s: float
    peak_rss_bytes: int | None
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class ArchiveSource:
    format: str
    path: Path
    payload_bytes: int | None
    source_kind: str


@dataclass
class BenchmarkRow:
    command: str
    path_id: str
    status: str
    reason: str | None
    command_example: list[str] | None
    iterations: int
    warmups: int
    samples: list[TrialSample]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark CLI command paths for compress/extract/checksum/patch-create/patch-apply "
            "with elapsed time, peak RSS, and throughput metrics."
        )
    )
    parser.add_argument(
        "--bin",
        type=Path,
        default=Path("target/debug/rom-weaver"),
        help="Path to rom-weaver binary (default: target/debug/rom-weaver)",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=Path(".tmp/bench-command-paths"),
        help="Temporary benchmark workspace root",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Optional path to write detailed JSON results",
    )
    parser.add_argument("--size-mib", type=int, default=32, help="Source fixture size in MiB")
    parser.add_argument(
        "--patch-size-mib",
        type=int,
        default=16,
        help="Patch original/modified fixture size in MiB",
    )
    parser.add_argument("--threads", type=int, default=8, help="Thread count passed to CLI commands")
    parser.add_argument("--warmups", type=int, default=1, help="Warmup runs per benchmark case")
    parser.add_argument("--iterations", type=int, default=3, help="Measured runs per benchmark case")
    parser.add_argument("--timeout-sec", type=int, default=900, help="Per-command timeout in seconds")
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip automatic cargo build when the binary is missing",
    )
    parser.add_argument(
        "--keep-work-dir",
        action="store_true",
        help="Keep workspace files after completion",
    )
    parser.add_argument(
        "--commands",
        default="compress,extract,checksum,patch-create,patch-apply",
        help="Comma-separated subset of commands to run",
    )
    return parser.parse_args()


def parse_command_filter(raw: str) -> set[str]:
    values = {value.strip().lower() for value in raw.split(",") if value.strip()}
    if not values:
        raise ValueError("--commands must include at least one command")
    valid = {"compress", "extract", "checksum", "patch-create", "patch-apply"}
    unknown = sorted(values - valid)
    if unknown:
        raise ValueError(f"unknown commands in --commands: {', '.join(unknown)}")
    return values


def ensure_binary(bin_path: Path, skip_build: bool) -> None:
    if bin_path.exists():
        return
    if skip_build:
        raise SystemExit(f"binary missing and --skip-build set: {bin_path}")
    release = "release" in set(bin_path.parts)
    cmd = ["cargo", "build", "-p", "rom-weaver-cli"]
    if release:
        cmd.append("--release")
    subprocess.run(cmd, check=True)


def token(value: str) -> str:
    chars = []
    for char in value.lower():
        if char.isalnum():
            chars.append(char)
        else:
            chars.append("-")
    collapsed = "".join(chars).strip("-")
    while "--" in collapsed:
        collapsed = collapsed.replace("--", "-")
    return collapsed or "unknown"


def container_suffix(format_name: str) -> str:
    return CONTAINER_SUFFIX.get(format_name, format_name)


def percentile(values: list[float], p: float) -> float:
    if not values:
        raise ValueError("cannot compute percentile of empty values")
    if len(values) == 1:
        return values[0]
    ordered = sorted(values)
    rank = (len(ordered) - 1) * p
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    frac = rank - lo
    return ordered[lo] * (1.0 - frac) + ordered[hi] * frac


def sum_file_bytes(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            total += child.stat().st_size
    return total


def write_random_fixture(path: Path, size_bytes: int, seed: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    chunk_size = 1024 * 1024
    with path.open("wb") as handle:
        remaining = size_bytes
        while remaining > 0:
            chunk_len = min(chunk_size, remaining)
            handle.write(rng.randbytes(chunk_len))
            remaining -= chunk_len


def write_test_gamecube_iso_fixture(path: Path, payload_bytes: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    total_len = max(0x440 + payload_bytes, 0x440)
    image = bytearray(total_len)
    image[:6] = b"RWTEST"
    image[0x1C:0x20] = bytes([0xC2, 0x33, 0x9F, 0x3D])
    title = b"rom-weaver-bench\x00"
    image[0x20 : 0x20 + len(title)] = title
    for index in range(0x440, total_len):
        image[index] = index % 251
    path.write_bytes(image)


def write_modified_fixture(original: Path, modified: Path) -> None:
    data = bytearray(original.read_bytes())
    if not data:
        modified.write_bytes(data)
        return

    length = len(data)
    edit_budget = min(512 * 1024, max(64 * 1024, length // 8))
    block_len = 4096
    block_count = max(1, edit_budget // block_len)
    stride = max(block_len, length // block_count)
    offset = 17
    for block_index in range(block_count):
        start = min(length - 1, offset + block_index * stride)
        end = min(length, start + block_len)
        delta = 37 + (block_index % 11)
        for index in range(start, end):
            data[index] = (data[index] + delta) % 256
    modified.write_bytes(data)


def write_i32_le(buffer: bytearray, offset: int, value: int) -> None:
    value = value & 0xFFFFFFFF
    buffer[offset : offset + 4] = struct.pack("<I", value)


def build_test_dldi_driver(
    *,
    driver_log2: int,
    base_address: int,
    friendly_name: str,
    fix_flags: int,
) -> bytearray:
    size = 1 << driver_log2
    data = bytearray(size)
    data[DLDI_DO_MAGIC_STRING : DLDI_DO_MAGIC_STRING + len(DLDI_MAGIC)] = DLDI_MAGIC
    data[DLDI_DO_VERSION] = DLDI_VERSION
    data[DLDI_DO_DRIVER_SIZE] = driver_log2
    data[DLDI_DO_FIX_SECTIONS] = fix_flags
    data[DLDI_DO_ALLOCATED_SPACE] = driver_log2

    name_bytes = friendly_name.encode("utf-8")
    max_name_len = DLDI_DO_TEXT_START - DLDI_DO_FRIENDLY_NAME
    copy_len = min(len(name_bytes), max_name_len - 1)
    data[DLDI_DO_FRIENDLY_NAME : DLDI_DO_FRIENDLY_NAME + copy_len] = name_bytes[:copy_len]

    write_i32_le(data, DLDI_DO_TEXT_START, base_address)
    write_i32_le(data, DLDI_DO_DATA_END, base_address + size)
    write_i32_le(data, DLDI_DO_GLUE_START, base_address + 0xA0)
    write_i32_le(data, DLDI_DO_GLUE_END, base_address + 0xA8)
    write_i32_le(data, DLDI_DO_GOT_START, base_address + 0xA8)
    write_i32_le(data, DLDI_DO_GOT_END, base_address + 0xB0)
    write_i32_le(data, DLDI_DO_BSS_START, base_address + 0xB0)
    write_i32_le(data, DLDI_DO_BSS_END, base_address + 0xC0)
    write_i32_le(data, DLDI_DO_STARTUP, base_address + DLDI_DO_CODE)
    write_i32_le(data, DLDI_DO_READ_SECTORS, base_address + DLDI_DO_CODE + 8)
    write_i32_le(data, DLDI_DO_WRITE_SECTORS, base_address + DLDI_DO_CODE + 12)
    write_i32_le(data, DLDI_DO_SHUTDOWN, base_address + DLDI_DO_CODE + 16)
    write_i32_le(data, DLDI_DO_CODE + 4, base_address + 0xD0)
    write_i32_le(data, DLDI_DO_CODE + 12, base_address + 0xD8)
    write_i32_le(data, 0xA0, base_address + 0x80)
    write_i32_le(data, 0xA8, base_address + 0x84)
    data[0xB0:0xC0] = b"\x7F" * 0x10
    return data


def build_test_dldi_app_with_slot(
    *,
    slot_offset: int,
    allocated_log2: int,
    mem_offset: int,
    friendly_name: str,
) -> bytearray:
    slot_size = 1 << allocated_log2
    total = slot_offset + slot_size + 0x80
    file_bytes = bytearray([0xCD] * total)
    slot = build_test_dldi_driver(
        driver_log2=allocated_log2,
        base_address=mem_offset,
        friendly_name=friendly_name,
        fix_flags=DLDI_FIX_ALL | DLDI_FIX_GLUE | DLDI_FIX_GOT | DLDI_FIX_BSS,
    )
    slot[DLDI_DO_ALLOCATED_SPACE] = allocated_log2
    file_bytes[slot_offset : slot_offset + slot_size] = slot
    return file_bytes


def write_dldi_original_fixture(path: Path, min_size_bytes: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = build_test_dldi_app_with_slot(
        slot_offset=DLDI_SLOT_OFFSET,
        allocated_log2=DLDI_SLOT_ALLOCATED_LOG2,
        mem_offset=DLDI_SLOT_MEM_OFFSET,
        friendly_name="Default driver",
    )
    if len(data) < min_size_bytes:
        growth = min_size_bytes - len(data)
        data.extend((index * 29) % 251 for index in range(growth))
    path.write_bytes(data)


def write_dldi_patch_fixture(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    patch = build_test_dldi_driver(
        driver_log2=DLDI_PATCH_DRIVER_LOG2,
        base_address=DLDI_PATCH_BASE_ADDRESS,
        friendly_name="Bench DLDI Driver",
        fix_flags=DLDI_FIX_ALL | DLDI_FIX_GLUE | DLDI_FIX_GOT | DLDI_FIX_BSS,
    )
    path.write_bytes(patch)


def base_command(bin_path: Path, args: list[str]) -> list[str]:
    return [str(bin_path), "--no-progress", *args]


def timed_wrapper(cmd: list[str], stats_file: Path) -> list[str]:
    if not TIME_BIN.exists():
        raise FileNotFoundError(f"required timing binary not found: {TIME_BIN}")
    if platform.system() == "Darwin":
        return [str(TIME_BIN), "-l", "-o", str(stats_file), *cmd]
    return [str(TIME_BIN), "-v", "-o", str(stats_file), *cmd]


def parse_peak_rss_bytes(stats_text: str) -> int | None:
    system = platform.system()
    if system == "Darwin":
        max_rss = None
        peak_footprint = None
        for line in stats_text.splitlines():
            line = line.strip()
            if line.endswith("maximum resident set size"):
                raw = line.split()[0]
                if raw.isdigit():
                    max_rss = int(raw)
            elif line.endswith("peak memory footprint"):
                raw = line.split()[0]
                if raw.isdigit():
                    peak_footprint = int(raw)
        candidates = [value for value in (max_rss, peak_footprint) if value is not None]
        if not candidates:
            return None
        return max(candidates)

    # GNU time -v format: "Maximum resident set size (kbytes): 12345"
    for line in stats_text.splitlines():
        line = line.strip()
        prefix = "Maximum resident set size (kbytes):"
        if line.startswith(prefix):
            raw = line[len(prefix) :].strip()
            if raw.isdigit():
                return int(raw) * 1024
    return None


def run_timed_command(cmd: list[str], cwd: Path, timeout_sec: int) -> RunOutcome:
    with tempfile.NamedTemporaryFile(prefix="rw-bench-time-", suffix=".txt", delete=False) as handle:
        stats_path = Path(handle.name)

    wrapped = timed_wrapper(cmd, stats_path)
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            wrapped,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_sec,
        )
        elapsed = time.perf_counter() - started
        stats_text = ""
        if stats_path.exists():
            stats_text = stats_path.read_text(encoding="utf-8", errors="replace")
        peak_rss_bytes = parse_peak_rss_bytes(stats_text)
        return RunOutcome(
            elapsed_s=elapsed,
            peak_rss_bytes=peak_rss_bytes,
            exit_code=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
        )
    except subprocess.TimeoutExpired as error:
        elapsed = time.perf_counter() - started
        stats_text = ""
        if stats_path.exists():
            stats_text = stats_path.read_text(encoding="utf-8", errors="replace")
        peak_rss_bytes = parse_peak_rss_bytes(stats_text)
        timeout_message = f"timed out after {timeout_sec}s"
        stderr = (error.stderr or "")
        if timeout_message not in stderr:
            stderr = f"{stderr}\n{timeout_message}".strip()
        return RunOutcome(
            elapsed_s=elapsed,
            peak_rss_bytes=peak_rss_bytes,
            exit_code=124,
            stdout=error.stdout or "",
            stderr=stderr,
        )
    finally:
        try:
            stats_path.unlink(missing_ok=True)
        except OSError:
            pass


def outcome_tail_message(outcome: RunOutcome) -> str:
    stderr = (outcome.stderr or "").strip()
    if stderr:
        return stderr.splitlines()[-1]
    stdout = (outcome.stdout or "").strip()
    if stdout:
        return stdout.splitlines()[-1]
    return ""


def summarize_row(row: BenchmarkRow) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "command": row.command,
        "path_id": row.path_id,
        "status": row.status,
        "reason": row.reason,
        "command_example": row.command_example,
        "iterations": row.iterations,
        "warmups": row.warmups,
        "samples": [asdict(sample) for sample in row.samples],
    }
    if row.status != "succeeded" or not row.samples:
        payload["metrics"] = None
        return payload

    elapsed = [sample.elapsed_s for sample in row.samples]
    peak_rss_values = [sample.peak_rss_bytes for sample in row.samples if sample.peak_rss_bytes is not None]
    throughputs = []
    for sample in row.samples:
        if sample.processed_bytes is not None and sample.elapsed_s > 0:
            throughputs.append(sample.processed_bytes / MIB / sample.elapsed_s)

    metrics: dict[str, Any] = {
        "elapsed_avg_s": statistics.mean(elapsed),
        "elapsed_p50_s": statistics.median(elapsed),
        "elapsed_p90_s": percentile(elapsed, 0.9),
        "elapsed_min_s": min(elapsed),
        "elapsed_max_s": max(elapsed),
        "peak_rss_avg_mib": (statistics.mean(peak_rss_values) / MIB) if peak_rss_values else None,
        "peak_rss_max_mib": (max(peak_rss_values) / MIB) if peak_rss_values else None,
        "throughput_avg_mib_s": statistics.mean(throughputs) if throughputs else None,
        "throughput_p50_mib_s": statistics.median(throughputs) if throughputs else None,
    }
    payload["metrics"] = metrics
    return payload


def run_benchmark_case(
    *,
    command: str,
    path_id: str,
    warmups: int,
    iterations: int,
    timeout_sec: int,
    command_factory,
    processed_bytes_factory,
) -> BenchmarkRow:
    samples: list[TrialSample] = []
    command_example: list[str] | None = None
    print(f"[bench] start {command} {path_id}", flush=True)

    for warmup_index in range(warmups):
        cmd, context = command_factory(warmup_index, True)
        command_example = cmd
        outcome = run_timed_command(cmd, Path.cwd(), timeout_sec)
        if outcome.exit_code != 0:
            reason = f"warmup failed (exit {outcome.exit_code})"
            tail = outcome_tail_message(outcome)
            if tail:
                reason = f"{reason}: {tail}"
            print(f"[bench] failed {command} {path_id}: {reason}", flush=True)
            return BenchmarkRow(
                command=command,
                path_id=path_id,
                status="failed",
                reason=reason,
                command_example=command_example,
                iterations=iterations,
                warmups=warmups,
                samples=samples,
            )
        _ = processed_bytes_factory(context)

    for iteration in range(iterations):
        cmd, context = command_factory(iteration, False)
        command_example = cmd
        outcome = run_timed_command(cmd, Path.cwd(), timeout_sec)
        if outcome.exit_code != 0:
            reason = f"iteration {iteration + 1} failed (exit {outcome.exit_code})"
            tail = outcome_tail_message(outcome)
            if tail:
                reason = f"{reason}: {tail}"
            print(f"[bench] failed {command} {path_id}: {reason}", flush=True)
            return BenchmarkRow(
                command=command,
                path_id=path_id,
                status="failed",
                reason=reason,
                command_example=command_example,
                iterations=iterations,
                warmups=warmups,
                samples=samples,
            )
        processed_bytes = processed_bytes_factory(context)
        samples.append(
            TrialSample(
                elapsed_s=outcome.elapsed_s,
                peak_rss_bytes=outcome.peak_rss_bytes,
                processed_bytes=processed_bytes,
            )
        )

    print(f"[bench] done {command} {path_id}", flush=True)
    return BenchmarkRow(
        command=command,
        path_id=path_id,
        status="succeeded",
        reason=None,
        command_example=command_example,
        iterations=iterations,
        warmups=warmups,
        samples=samples,
    )


def skipped_row(command: str, path_id: str, reason: str, warmups: int, iterations: int) -> BenchmarkRow:
    return BenchmarkRow(
        command=command,
        path_id=path_id,
        status="skipped",
        reason=reason,
        command_example=None,
        iterations=iterations,
        warmups=warmups,
        samples=[],
    )


def print_table(rows: list[dict[str, Any]]) -> None:
    print("\nCommand Path Benchmark Summary")
    print("command       path_id                         status      elapsed_avg_s  peak_rss_max_mib  throughput_avg_mib_s")
    print("------------  ------------------------------  ----------  -------------  ----------------  ---------------------")
    for row in rows:
        metrics = row.get("metrics") or {}
        elapsed_avg = metrics.get("elapsed_avg_s")
        peak_rss = metrics.get("peak_rss_max_mib")
        throughput = metrics.get("throughput_avg_mib_s")
        elapsed_text = f"{elapsed_avg:>13.4f}" if isinstance(elapsed_avg, (int, float)) else " " * 13 + "-"
        peak_text = f"{peak_rss:>16.2f}" if isinstance(peak_rss, (int, float)) else " " * 16 + "-"
        thr_text = f"{throughput:>21.2f}" if isinstance(throughput, (int, float)) else " " * 21 + "-"
        print(
            f"{row['command']:<12}  {row['path_id']:<30}  {row['status']:<10}  {elapsed_text}  {peak_text}  {thr_text}"
        )


def main() -> None:
    args = parse_args()
    selected_commands = parse_command_filter(args.commands)

    if args.size_mib <= 0 or args.patch_size_mib <= 0:
        raise SystemExit("--size-mib and --patch-size-mib must be positive integers")
    if args.threads <= 0 or args.warmups < 0 or args.iterations <= 0:
        raise SystemExit("--threads must be > 0, --warmups >= 0, and --iterations > 0")

    ensure_binary(args.bin, args.skip_build)

    work_dir = args.work_dir.resolve()
    if work_dir.exists():
        shutil.rmtree(work_dir)
    fixtures_dir = work_dir / "fixtures"
    artifacts_dir = work_dir / "artifacts"
    outputs_dir = work_dir / "outputs"
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)

    source_path = fixtures_dir / "source.bin"
    disc_source_path = fixtures_dir / "source-disc.iso"
    original_path = fixtures_dir / "original.bin"
    modified_path = fixtures_dir / "modified.bin"
    ips_ebp_original_path = fixtures_dir / "ips-ebp-original.bin"
    ips_ebp_modified_path = fixtures_dir / "ips-ebp-modified.bin"
    dldi_original_path = fixtures_dir / "dldi-original.nds"
    dldi_patch_driver_path = fixtures_dir / "dldi-driver.dldi"
    dldi_modified_path = fixtures_dir / "dldi-modified.nds"

    write_random_fixture(source_path, args.size_mib * MIB, seed=0xBADC0DE)
    write_test_gamecube_iso_fixture(disc_source_path, args.size_mib * MIB)
    write_random_fixture(original_path, args.patch_size_mib * MIB, seed=0xC0FFEE)
    write_modified_fixture(original_path, modified_path)
    ips_ebp_size_bytes = min(args.patch_size_mib * MIB, IPS_EBP_BENCH_MAX_BYTES)
    write_random_fixture(ips_ebp_original_path, ips_ebp_size_bytes, seed=0x1BADB002)
    write_modified_fixture(ips_ebp_original_path, ips_ebp_modified_path)
    write_dldi_original_fixture(dldi_original_path, args.patch_size_mib * MIB)
    write_dldi_patch_fixture(dldi_patch_driver_path)

    dldi_prep = run_timed_command(
        base_command(
            args.bin,
            [
                "patch-apply",
                "--input",
                str(dldi_original_path),
                "--patch",
                str(dldi_patch_driver_path),
                "--output",
                str(dldi_modified_path),
                "--no-compress",
                "--threads",
                str(args.threads),
            ],
        ),
        Path.cwd(),
        args.timeout_sec,
    )
    if dldi_prep.exit_code != 0 or not dldi_modified_path.exists():
        detail = (dldi_prep.stderr or "").strip()
        tail = detail.splitlines()[-1] if detail else "unknown error"
        raise SystemExit(f"failed to prepare DLDI benchmark fixtures: {tail}")
    print("[bench] prepared DLDI original/modified fixtures", flush=True)

    def validate_large_ips_family_failure(format_name: str) -> None:
        extension = PATCH_EXTENSION[format_name]
        output_path = artifacts_dir / "validation" / f"{token(format_name)}-limit.{extension}"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            output_path.unlink()
        cmd = base_command(
            args.bin,
            [
                "patch-create",
                "--original",
                str(original_path),
                "--modified",
                str(modified_path),
                "--format",
                format_name,
                "--output",
                str(output_path),
                "--threads",
                str(args.threads),
            ],
        )
        outcome = run_timed_command(cmd, Path.cwd(), args.timeout_sec)
        if outcome.exit_code == 0:
            raise SystemExit(
                f"expected {format_name} patch-create to fail for >16 MiB inputs, but it succeeded"
            )
        combined = f"{outcome.stdout}\n{outcome.stderr}".lower()
        if "24-bit limit" not in combined:
            tail = outcome_tail_message(outcome) or "unexpected validation failure"
            raise SystemExit(
                f"{format_name} large-input failure did not report IPS 24-bit limit: {tail}"
            )
        print(
            f"[bench] validated {format_name} large-input failure (IPS 24-bit limit)",
            flush=True,
        )

    if "patch-create" in selected_commands and original_path.stat().st_size > IPS_CREATE_MAX_INPUT_BYTES:
        for format_name in ("ips", "ebp"):
            validate_large_ips_family_failure(format_name)

    def compress_input_for_format(format_name: str) -> Path:
        if format_name in DISC_COMPRESS_INPUT_FORMATS:
            return disc_source_path
        return source_path

    rows: list[BenchmarkRow] = []

    # Prepare reusable extract/checksum archive inputs.
    archive_sources: dict[str, ArchiveSource] = {}
    static_extract_fixtures = {
        "rar": Path("tests/fixtures/rar/version.rar"),
    }

    for format_name in CONTAINER_FORMATS:
        print(f"[bench] prep archive source {format_name}", flush=True)
        input_path = compress_input_for_format(format_name)
        output_path = artifacts_dir / f"seed-{token(format_name)}.{container_suffix(format_name)}"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            output_path.unlink()

        cmd = base_command(
            args.bin,
            [
                "compress",
                str(input_path),
                "--format",
                format_name,
                "--output",
                str(output_path),
                "--threads",
                str(args.threads),
            ],
        )
        prep = run_timed_command(cmd, Path.cwd(), args.timeout_sec)
        if prep.exit_code == 0 and output_path.exists():
            archive_sources[format_name] = ArchiveSource(
                format=format_name,
                path=output_path,
                payload_bytes=input_path.stat().st_size,
                source_kind="generated",
            )
            print(f"[bench] prep ready {format_name} (generated)", flush=True)
            continue

        fixture = static_extract_fixtures.get(format_name)
        if fixture is not None and fixture.exists():
            archive_sources[format_name] = ArchiveSource(
                format=format_name,
                path=fixture,
                payload_bytes=None,
                source_kind="fixture",
            )
            print(f"[bench] prep ready {format_name} (fixture)", flush=True)
        else:
            print(f"[bench] prep unavailable {format_name}", flush=True)

    if "compress" in selected_commands:
        for format_name in CONTAINER_FORMATS:
            if format_name in EXPECTED_COMPRESS_SKIPS:
                rows.append(
                    skipped_row(
                        "compress",
                        f"format:{format_name}",
                        EXPECTED_COMPRESS_SKIPS[format_name],
                        args.warmups,
                        args.iterations,
                    )
                )
                continue

            input_path = compress_input_for_format(format_name)
            suffix = container_suffix(format_name)

            def make_command(
                iteration: int,
                warmup: bool,
                format_value: str = format_name,
                suffix_value: str = suffix,
                input_value: Path = input_path,
            ):
                run_kind = "warmup" if warmup else "run"
                output_path = (
                    outputs_dir
                    / "compress"
                    / f"{token(format_value)}-{run_kind}-{iteration}.{suffix_value}"
                )
                output_path.parent.mkdir(parents=True, exist_ok=True)
                if output_path.exists():
                    output_path.unlink()
                cmd = base_command(
                    args.bin,
                    [
                        "compress",
                        str(input_value),
                        "--format",
                        format_value,
                        "--output",
                        str(output_path),
                        "--threads",
                        str(args.threads),
                    ],
                )
                return cmd, output_path

            def processed_bytes(_context: Path, input_value: Path = input_path) -> int:
                return input_value.stat().st_size

            rows.append(
                run_benchmark_case(
                    command="compress",
                    path_id=f"format:{format_name}",
                    warmups=args.warmups,
                    iterations=args.iterations,
                    timeout_sec=args.timeout_sec,
                    command_factory=make_command,
                    processed_bytes_factory=processed_bytes,
                )
            )

    if "extract" in selected_commands:
        for format_name in CONTAINER_FORMATS:
            source = archive_sources.get(format_name)
            if source is None:
                rows.append(
                    skipped_row(
                        "extract",
                        f"format:{format_name}",
                        "no valid source artifact available for this format",
                        args.warmups,
                        args.iterations,
                    )
                )
                continue

            def make_command(
                iteration: int,
                warmup: bool,
                format_value: str = format_name,
                source_value: ArchiveSource = source,
            ):
                run_kind = "warmup" if warmup else "run"
                out_dir = outputs_dir / "extract" / f"{token(format_value)}-{run_kind}-{iteration}"
                if out_dir.exists():
                    shutil.rmtree(out_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                cmd = base_command(
                    args.bin,
                    [
                        "extract",
                        str(source_value.path),
                        "--out-dir",
                        str(out_dir),
                        "--threads",
                        str(args.threads),
                    ],
                )
                return cmd, out_dir

            def processed_bytes(out_dir: Path, source_value: ArchiveSource = source) -> int | None:
                extracted = sum_file_bytes(out_dir)
                return extracted if extracted > 0 else source_value.payload_bytes

            rows.append(
                run_benchmark_case(
                    command="extract",
                    path_id=f"format:{format_name}",
                    warmups=args.warmups,
                    iterations=args.iterations,
                    timeout_sec=args.timeout_sec,
                    command_factory=make_command,
                    processed_bytes_factory=processed_bytes,
                )
            )

    if "checksum" in selected_commands:
        for algorithm in CHECKSUM_ALGORITHMS:

            def make_command(_iteration: int, _warmup: bool, algo: str = algorithm):
                cmd = base_command(
                    args.bin,
                    [
                        "checksum",
                        str(source_path),
                        "--algo",
                        algo,
                        "--no-extract",
                        "--threads",
                        str(args.threads),
                    ],
                )
                return cmd, source_path

            def processed_bytes(_context: Path) -> int:
                return source_path.stat().st_size

            rows.append(
                run_benchmark_case(
                    command="checksum",
                    path_id=f"algo:{algorithm}",
                    warmups=args.warmups,
                    iterations=args.iterations,
                    timeout_sec=args.timeout_sec,
                    command_factory=make_command,
                    processed_bytes_factory=processed_bytes,
                )
            )

        for format_name in CONTAINER_FORMATS:
            source = archive_sources.get(format_name)
            if source is None:
                rows.append(
                    skipped_row(
                        "checksum",
                        f"auto-extract:{format_name}",
                        "no valid archive artifact available for auto-extract checksum path",
                        args.warmups,
                        args.iterations,
                    )
                )
                continue

            def make_command(_iteration: int, _warmup: bool, source_value: ArchiveSource = source):
                cmd = base_command(
                    args.bin,
                    [
                        "checksum",
                        str(source_value.path),
                        "--algo",
                        "sha256",
                        "--threads",
                        str(args.threads),
                    ],
                )
                return cmd, source_value

            def processed_bytes(source_value: ArchiveSource) -> int | None:
                return source_value.payload_bytes

            rows.append(
                run_benchmark_case(
                    command="checksum",
                    path_id=f"auto-extract:{format_name}",
                    warmups=args.warmups,
                    iterations=args.iterations,
                    timeout_sec=args.timeout_sec,
                    command_factory=make_command,
                    processed_bytes_factory=processed_bytes,
                )
            )

    created_patch_sources: dict[str, tuple[Path, Path]] = {}

    if "patch-create" in selected_commands:
        for format_name in PATCH_FORMATS:
            if format_name in EXPECTED_PATCH_CREATE_SKIPS:
                rows.append(
                    skipped_row(
                        "patch-create",
                        f"format:{format_name}",
                        EXPECTED_PATCH_CREATE_SKIPS[format_name],
                        args.warmups,
                        args.iterations,
                    )
                )
                continue

            extension = PATCH_EXTENSION[format_name]
            if format_name == "dldi":
                patch_original = dldi_original_path
                patch_modified = dldi_modified_path
            elif format_name in {"ips", "ebp"}:
                patch_original = ips_ebp_original_path
                patch_modified = ips_ebp_modified_path
            else:
                patch_original = original_path
                patch_modified = modified_path

            def make_command(
                _iteration: int,
                _warmup: bool,
                format_value: str = format_name,
                extension_value: str = extension,
                original_value: Path = patch_original,
                modified_value: Path = patch_modified,
            ):
                patch_path = artifacts_dir / "patches" / f"{token(format_value)}.{extension_value}"
                patch_path.parent.mkdir(parents=True, exist_ok=True)
                if patch_path.exists():
                    patch_path.unlink()
                cmd = base_command(
                    args.bin,
                    [
                        "patch-create",
                        "--original",
                        str(original_value),
                        "--modified",
                        str(modified_value),
                        "--format",
                        format_value,
                        "--output",
                        str(patch_path),
                        "--threads",
                        str(args.threads),
                    ],
                )
                return cmd, patch_path

            def processed_bytes(
                _patch_path: Path,
                original_value: Path = patch_original,
                modified_value: Path = patch_modified,
            ) -> int:
                return original_value.stat().st_size + modified_value.stat().st_size

            row = run_benchmark_case(
                command="patch-create",
                path_id=f"format:{format_name}",
                warmups=args.warmups,
                iterations=args.iterations,
                timeout_sec=args.timeout_sec,
                command_factory=make_command,
                processed_bytes_factory=processed_bytes,
            )
            rows.append(row)

            if row.status == "succeeded":
                patch_path = artifacts_dir / "patches" / f"{token(format_name)}.{extension}"
                if patch_path.exists():
                    created_patch_sources[format_name] = (patch_path, patch_original)

    static_patch_apply_fixtures = {
        "xdelta": {
            "input": Path("tests/fixtures/vcdiff/secondary-source.bin"),
            "patch": Path("tests/fixtures/vcdiff/secondary-djw.xdelta"),
        },
        "vcdiff": {
            "input": Path("tests/fixtures/vcdiff/secondary-source.bin"),
            "patch": Path("tests/fixtures/vcdiff/secondary-djw.xdelta"),
        },
    }
    patch_apply_ignore_checksum_formats = {"mod"}

    if "patch-apply" in selected_commands:
        for format_name in PATCH_FORMATS:
            created_patch = created_patch_sources.get(format_name)
            if created_patch is not None and created_patch[0].exists():
                patch_path, input_path = created_patch
                source_kind = "generated"
            else:
                fixture = static_patch_apply_fixtures.get(format_name)
                if fixture is None or not fixture["input"].exists() or not fixture["patch"].exists():
                    rows.append(
                        skipped_row(
                            "patch-apply",
                            f"format:{format_name}",
                            "no valid patch artifact available for this format",
                            args.warmups,
                            args.iterations,
                        )
                    )
                    continue
                input_path = fixture["input"]
                patch_path = fixture["patch"]
                source_kind = "fixture"

            def make_command(
                iteration: int,
                warmup: bool,
                format_value: str = format_name,
                input_value: Path = input_path,
                patch_value: Path = patch_path,
            ):
                run_kind = "warmup" if warmup else "run"
                output_path = (
                    outputs_dir
                    / "patch-apply"
                    / f"{token(format_value)}-{run_kind}-{iteration}.bin"
                )
                output_path.parent.mkdir(parents=True, exist_ok=True)
                if output_path.exists():
                    output_path.unlink()
                cmd = base_command(
                    args.bin,
                    [
                        "patch-apply",
                        "--input",
                        str(input_value),
                        "--patch",
                        str(patch_value),
                        "--output",
                        str(output_path),
                        "--no-compress",
                        *(
                            ["--ignore-checksum-validation"]
                            if format_value in patch_apply_ignore_checksum_formats
                            else []
                        ),
                        "--threads",
                        str(args.threads),
                    ],
                )
                return cmd, output_path

            def processed_bytes(
                _context: Path,
                input_value: Path = input_path,
                patch_value: Path = patch_path,
            ) -> int:
                return input_value.stat().st_size + patch_value.stat().st_size

            row = run_benchmark_case(
                command="patch-apply",
                path_id=f"format:{format_name} ({source_kind})",
                warmups=args.warmups,
                iterations=args.iterations,
                timeout_sec=args.timeout_sec,
                command_factory=make_command,
                processed_bytes_factory=processed_bytes,
            )
            rows.append(row)

    payload_rows = [summarize_row(row) for row in rows]
    status_counts: dict[str, int] = {"succeeded": 0, "failed": 0, "skipped": 0}
    for row in payload_rows:
        status = row["status"]
        status_counts[status] = status_counts.get(status, 0) + 1

    payload = {
        "meta": {
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "cwd": os.getcwd(),
            "binary": str(args.bin),
            "work_dir": str(work_dir),
            "commands": sorted(selected_commands),
            "threads": args.threads,
            "warmups": args.warmups,
            "iterations": args.iterations,
            "size_mib": args.size_mib,
            "patch_size_mib": args.patch_size_mib,
            "timeout_sec": args.timeout_sec,
            "python": sys.version,
            "platform": platform.platform(),
        },
        "status_counts": status_counts,
        "rows": payload_rows,
    }

    print_table(payload_rows)
    print("\nStatus counts:")
    for key in ("succeeded", "failed", "skipped"):
        print(f"- {key}: {status_counts.get(key, 0)}")

    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"\nWrote JSON results: {args.json_out}")

    print("\nJSON:")
    print(json.dumps(payload))

    if not args.keep_work_dir:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
