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
SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
WASM_BUILD_SCRIPT = REPO_ROOT / "scripts" / "build-wasm-cli.sh"

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

ARCHIVE_TOOLS = ["rom-weaver", "rom-weaver-wasm", "7zz"]

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

SEVENZIP_COMPRESS_ONE_STEP = {
    "7z": "7z",
    "zip": "zip",
    "zipx": "zip",
    "tar": "tar",
    "gz": "gzip",
    "bz2": "bzip2",
    "xz": "xz",
}

SEVENZIP_EXTRACT_FORMATS = {
    "7z",
    "zip",
    "zipx",
    "rar",
    "tar",
    "gz",
    "bz2",
    "xz",
    "zst",
}

DISC_COMPRESS_INPUT_FORMATS = {"rvz", "wia", "wbfs", "tgc"}

ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT = {
    "zipx": "zstd",
}

# Codec matrix for rom-weaver format/codec coverage.
# Entry tuples are (codec_label, codec_cli_value).
# zipx intentionally stays out of this matrix to avoid counting it in permutation totals.
ROM_WEAVER_CODEC_MATRIX_BY_FORMAT = {
    "zip": [("store", "store"), ("deflate", "deflate"), ("bzip2", "bzip2"), ("zstd", "zstd")],
    "7z": [
        ("lzma2", "lzma2"),
        ("lzma", "lzma"),
        ("store", "store"),
        ("zstd", "zstd:7"),
        ("deflate", "deflate"),
        ("bzip2", "bzip2"),
        ("ppmd", "ppmd"),
    ],
    "tar": [("store", "store")],
    "tar.gz": [("deflate", "deflate")],
    "tar.bz2": [("bzip2", "bzip2")],
    "tar.xz": [("lzma2", "lzma2"), ("lzma", "lzma")],
    "gz": [("deflate", "deflate")],
    "bz2": [("bzip2", "bzip2")],
    "xz": [("lzma2", "lzma2"), ("lzma", "lzma")],
    "zst": [("zstd", "zstd")],
    "cso": [("store", "store")],
    "chd": [
        ("zstd", "zstd"),
        ("zlib", "zlib"),
        ("lzma", "lzma"),
        ("huffman", "huffman"),
        ("flac", "flac"),
        ("store", "store"),
    ],
    "wia": [("store", "store"), ("zstd", "zstd"), ("bzip2", "bzip2"), ("lzma", "lzma"), ("lzma2", "lzma2")],
    "tgc": [("store", "store")],
    "wbfs": [("store", "store")],
    "rvz": [("store", "store"), ("zstd", "zstd"), ("bzip2", "bzip2"), ("lzma", "lzma"), ("lzma2", "lzma2")],
    "z3ds": [("zstd", "zstd")],
}

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
    tool: str = "rom-weaver"


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
        default=Path("target/release/rom-weaver"),
        help="Path to rom-weaver binary (default: target/release/rom-weaver)",
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
        help="Skip automatic pre-benchmark native+wasm rebuilds (still requires an existing binary)",
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
    parser.add_argument(
        "--container-formats",
        default="all",
        help="Comma-separated subset of container formats for compress/extract/checksum auto-extract (default: all)",
    )
    parser.add_argument(
        "--patch-formats",
        default="all",
        help="Comma-separated subset of patch formats for patch-create/patch-apply (default: all)",
    )
    parser.add_argument(
        "--checksum-algos",
        default="all",
        help="Comma-separated subset of checksum algorithms for raw checksum runs (default: all)",
    )
    parser.add_argument(
        "--checksum-modes",
        default="raw,auto-extract",
        help="Checksum paths to run: raw, auto-extract, or both (default: raw,auto-extract)",
    )
    parser.add_argument(
        "--rar-fixture",
        type=Path,
        default=Path("tests/fixtures/rar/version.rar"),
        help="RAR fixture path used when rar create is unavailable (default: tests/fixtures/rar/version.rar)",
    )
    parser.add_argument(
        "--archive-tools",
        default="rom-weaver",
        help="Archive benchmark tools to run for compress/extract (rom-weaver,rom-weaver-wasm,7zz). Default: rom-weaver",
    )
    parser.add_argument(
        "--sevenzip-bin",
        type=Path,
        default=Path(shutil.which("7zz") or "7zz"),
        help="Path to 7zz binary used when archive-tools includes 7zz (default: PATH lookup for 7zz)",
    )
    parser.add_argument(
        "--node-bin",
        type=Path,
        default=Path(shutil.which("node") or "node"),
        help="Path to Node.js binary used when archive-tools includes rom-weaver-wasm (default: PATH lookup for node)",
    )
    parser.add_argument(
        "--wasm-runner",
        type=Path,
        default=Path("scripts/wasm/run-wasi-cli.mjs"),
        help="Path to wasm runner wrapper script used for rom-weaver-wasm archive tool",
    )
    parser.add_argument(
        "--wasm-module",
        type=Path,
        default=Path("packages/rom-weaver-wasm/rom-weaver-cli.wasm"),
        help="Path to rom-weaver CLI wasm module used for rom-weaver-wasm archive tool",
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


def parse_value_filter(raw: str, valid_values: list[str], flag_name: str) -> list[str]:
    values = [value.strip().lower() for value in raw.split(",") if value.strip()]
    if not values:
        raise ValueError(f"{flag_name} must include at least one value")
    value_set = set(values)
    if value_set <= {"all", "*"}:
        return list(valid_values)
    if "all" in value_set or "*" in value_set:
        raise ValueError(f"{flag_name} cannot combine 'all' with specific values")
    valid_set = set(valid_values)
    unknown = sorted(value_set - valid_set)
    if unknown:
        raise ValueError(f"unknown values in {flag_name}: {', '.join(unknown)}")
    return [value for value in valid_values if value in value_set]


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


def rebuild_release_and_wasm(skip_build: bool, needs_rom_weaver: bool) -> None:
    if skip_build or not needs_rom_weaver:
        return
    print("[bench] rebuild release binary", flush=True)
    subprocess.run(["cargo", "build", "-p", "rom-weaver-cli", "--release"], check=True, cwd=REPO_ROOT)
    print("[bench] rebuild wasm artifacts", flush=True)
    subprocess.run(["bash", str(WASM_BUILD_SCRIPT)], check=True, cwd=REPO_ROOT)


def resolve_external_binary(bin_path: Path, flag_name: str) -> Path:
    candidate = bin_path.expanduser()
    if candidate.exists():
        return candidate.resolve()
    resolved = shutil.which(str(candidate))
    if resolved is not None:
        return Path(resolved)
    raise SystemExit(f"{flag_name} binary not found: {bin_path}")


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


def rom_weaver_codec_cases_for_format(format_name: str) -> list[tuple[str, str | None]]:
    codecs = ROM_WEAVER_CODEC_MATRIX_BY_FORMAT.get(format_name)
    if codecs is not None:
        return list(codecs)
    default_codec = ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT.get(format_name)
    if default_codec is not None:
        return [(default_codec, default_codec)]
    return [("default", None)]


def format_codec_path_id(format_name: str, codec_label: str) -> str:
    return f"format:{format_name},codec:{codec_label}"


def rom_weaver_compress_args(
    *,
    input_path: Path,
    format_name: str,
    output_path: Path,
    threads: int,
    codec_override: str | None = None,
) -> list[str]:
    args = [
        "compress",
        str(input_path),
        "--format",
        format_name,
        "--output",
        str(output_path),
        "--threads",
        str(threads),
    ]
    codec = codec_override
    if codec is None:
        codec = ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT.get(format_name)
    if codec is not None:
        args.extend(["--codec", codec])
    return args


def sevenzip_command(sevenzip_bin: Path, args: list[str]) -> list[str]:
    return [str(sevenzip_bin), *args]


def wasm_rom_weaver_command(
    *,
    node_bin: Path,
    wasm_runner: Path,
    wasm_module: Path,
    args: list[str],
) -> list[str]:
    return [
        str(node_bin),
        "--no-warnings",
        str(wasm_runner),
        "--wasm-module",
        str(wasm_module),
        "--",
        *args,
    ]


def sevenzip_compress_command(
    *,
    sevenzip_bin: Path,
    format_name: str,
    input_path: Path,
    output_path: Path,
    threads: int,
) -> list[str]:
    one_step_type = SEVENZIP_COMPRESS_ONE_STEP.get(format_name)
    if one_step_type is None:
        raise ValueError(f"7zz compress is not configured for format: {format_name}")
    return sevenzip_command(
        sevenzip_bin,
        [
            "a",
            "-y",
            "-bd",
            f"-mmt={threads}",
            f"-t{one_step_type}",
            str(output_path),
            str(input_path),
        ],
    )


def sevenzip_extract_command(
    *,
    sevenzip_bin: Path,
    format_name: str,
    source_path: Path,
    output_dir: Path,
    threads: int,
) -> list[str]:
    if format_name not in SEVENZIP_EXTRACT_FORMATS:
        raise ValueError(f"7zz extract is not configured for format: {format_name}")

    return sevenzip_command(
        sevenzip_bin,
        [
            "x",
            "-y",
            "-bd",
            f"-mmt={threads}",
            str(source_path),
            f"-o{output_dir}",
        ],
    )


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
        "tool": row.tool,
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
    tool: str = "rom-weaver",
) -> BenchmarkRow:
    samples: list[TrialSample] = []
    command_example: list[str] | None = None
    print(f"[bench] start {tool} {command} {path_id}", flush=True)

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
                tool=tool,
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
                tool=tool,
            )
        processed_bytes = processed_bytes_factory(context)
        samples.append(
            TrialSample(
                elapsed_s=outcome.elapsed_s,
                peak_rss_bytes=outcome.peak_rss_bytes,
                processed_bytes=processed_bytes,
            )
        )

    print(f"[bench] done {tool} {command} {path_id}", flush=True)
    return BenchmarkRow(
        command=command,
        path_id=path_id,
        status="succeeded",
        reason=None,
        command_example=command_example,
        iterations=iterations,
        warmups=warmups,
        samples=samples,
        tool=tool,
    )


def skipped_row(
    command: str,
    path_id: str,
    reason: str,
    warmups: int,
    iterations: int,
    tool: str = "rom-weaver",
) -> BenchmarkRow:
    return BenchmarkRow(
        command=command,
        path_id=path_id,
        status="skipped",
        reason=reason,
        command_example=None,
        iterations=iterations,
        warmups=warmups,
        samples=[],
        tool=tool,
    )


def print_table(rows: list[dict[str, Any]]) -> None:
    print("\nCommand Path Benchmark Summary")
    print("tool         command       path_id                         status      elapsed_avg_s  peak_rss_max_mib  throughput_avg_mib_s")
    print("-----------  ------------  ------------------------------  ----------  -------------  ----------------  ---------------------")
    for row in rows:
        metrics = row.get("metrics") or {}
        elapsed_avg = metrics.get("elapsed_avg_s")
        peak_rss = metrics.get("peak_rss_max_mib")
        throughput = metrics.get("throughput_avg_mib_s")
        elapsed_text = f"{elapsed_avg:>13.4f}" if isinstance(elapsed_avg, (int, float)) else " " * 13 + "-"
        peak_text = f"{peak_rss:>16.2f}" if isinstance(peak_rss, (int, float)) else " " * 16 + "-"
        thr_text = f"{throughput:>21.2f}" if isinstance(throughput, (int, float)) else " " * 21 + "-"
        print(
            f"{row.get('tool', 'rom-weaver'):<11}  {row['command']:<12}  {row['path_id']:<30}  {row['status']:<10}  {elapsed_text}  {peak_text}  {thr_text}"
        )


def main() -> None:
    args = parse_args()
    selected_commands = parse_command_filter(args.commands)
    selected_archive_tools = parse_value_filter(args.archive_tools, ARCHIVE_TOOLS, "--archive-tools")
    selected_container_formats = parse_value_filter(args.container_formats, CONTAINER_FORMATS, "--container-formats")
    selected_patch_formats = parse_value_filter(args.patch_formats, PATCH_FORMATS, "--patch-formats")
    selected_checksum_algorithms = parse_value_filter(args.checksum_algos, CHECKSUM_ALGORITHMS, "--checksum-algos")
    selected_checksum_modes = set(
        parse_value_filter(args.checksum_modes, ["raw", "auto-extract"], "--checksum-modes")
    )

    if args.size_mib <= 0 or args.patch_size_mib <= 0:
        raise SystemExit("--size-mib and --patch-size-mib must be positive integers")
    if args.threads <= 0 or args.warmups < 0 or args.iterations <= 0:
        raise SystemExit("--threads must be > 0, --warmups >= 0, and --iterations > 0")

    needs_rom_weaver = (
        "rom-weaver" in selected_archive_tools
        or "rom-weaver-wasm" in selected_archive_tools
        or "checksum" in selected_commands
        or "patch-create" in selected_commands
        or "patch-apply" in selected_commands
    )
    rebuild_release_and_wasm(args.skip_build, needs_rom_weaver)
    if needs_rom_weaver:
        ensure_binary(args.bin, args.skip_build)
    sevenzip_bin: Path | None = None
    if "7zz" in selected_archive_tools:
        sevenzip_bin = resolve_external_binary(args.sevenzip_bin, "--sevenzip-bin")
    node_bin: Path | None = None
    wasm_runner: Path | None = None
    wasm_module: Path | None = None
    if "rom-weaver-wasm" in selected_archive_tools:
        node_bin = resolve_external_binary(args.node_bin, "--node-bin")
        wasm_runner = args.wasm_runner.expanduser().resolve()
        if not wasm_runner.exists():
            raise SystemExit(f"--wasm-runner file not found: {wasm_runner}")
        wasm_module = args.wasm_module.expanduser().resolve()
        if not wasm_module.exists():
            raise SystemExit(f"--wasm-module file not found: {wasm_module}")

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

    source_ready = False
    disc_source_ready = False
    patch_pair_ready = False
    ips_ebp_ready = False
    dldi_ready = False

    def ensure_source_fixture() -> None:
        nonlocal source_ready
        if source_ready:
            return
        write_random_fixture(source_path, args.size_mib * MIB, seed=0xBADC0DE)
        source_ready = True

    def ensure_disc_source_fixture() -> None:
        nonlocal disc_source_ready
        if disc_source_ready:
            return
        write_test_gamecube_iso_fixture(disc_source_path, args.size_mib * MIB)
        disc_source_ready = True

    def ensure_patch_pair_fixtures() -> None:
        nonlocal patch_pair_ready
        if patch_pair_ready:
            return
        write_random_fixture(original_path, args.patch_size_mib * MIB, seed=0xC0FFEE)
        write_modified_fixture(original_path, modified_path)
        patch_pair_ready = True

    def ensure_ips_ebp_fixtures() -> None:
        nonlocal ips_ebp_ready
        if ips_ebp_ready:
            return
        ips_ebp_size_bytes = min(args.patch_size_mib * MIB, IPS_EBP_BENCH_MAX_BYTES)
        write_random_fixture(ips_ebp_original_path, ips_ebp_size_bytes, seed=0x1BADB002)
        write_modified_fixture(ips_ebp_original_path, ips_ebp_modified_path)
        ips_ebp_ready = True

    def ensure_dldi_fixtures() -> None:
        nonlocal dldi_ready
        if dldi_ready:
            return
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
        dldi_ready = True

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

    if "patch-create" in selected_commands and {"ips", "ebp"} & set(selected_patch_formats):
        ensure_patch_pair_fixtures()
        if original_path.stat().st_size > IPS_CREATE_MAX_INPUT_BYTES:
            for format_name in ("ips", "ebp"):
                if format_name in selected_patch_formats:
                    validate_large_ips_family_failure(format_name)

    def compress_input_for_format(format_name: str) -> Path:
        if format_name in DISC_COMPRESS_INPUT_FORMATS:
            ensure_disc_source_fixture()
            return disc_source_path
        ensure_source_fixture()
        return source_path

    rows: list[BenchmarkRow] = []

    # Prepare reusable extract/checksum archive inputs.
    archive_sources: dict[tuple[str, str], ArchiveSource] = {}
    archive_sources_default: dict[str, ArchiveSource] = {}
    static_extract_fixtures = {
        "rar": args.rar_fixture,
    }

    needs_archive_sources = ("extract" in selected_commands) or (
        "checksum" in selected_commands and "auto-extract" in selected_checksum_modes
    )
    if needs_archive_sources:
        for format_name in selected_container_formats:
            codec_cases = rom_weaver_codec_cases_for_format(format_name)
            for codec_label, codec_value in codec_cases:
                print(f"[bench] prep archive source {format_name} codec:{codec_label}", flush=True)
                input_path = compress_input_for_format(format_name)
                output_path = (
                    artifacts_dir
                    / f"seed-{token(format_name)}-{token(codec_label)}.{container_suffix(format_name)}"
                )
                output_path.parent.mkdir(parents=True, exist_ok=True)
                if output_path.exists():
                    output_path.unlink()

                cmd = base_command(
                    args.bin,
                    rom_weaver_compress_args(
                        input_path=input_path,
                        format_name=format_name,
                        output_path=output_path,
                        threads=args.threads,
                        codec_override=codec_value,
                    ),
                )
                prep = run_timed_command(cmd, Path.cwd(), args.timeout_sec)
                if prep.exit_code == 0 and output_path.exists():
                    source = ArchiveSource(
                        format=format_name,
                        path=output_path,
                        payload_bytes=input_path.stat().st_size,
                        source_kind="generated",
                    )
                    archive_sources[(format_name, codec_label)] = source
                    archive_sources_default.setdefault(format_name, source)
                    print(
                        f"[bench] prep ready {format_name} codec:{codec_label} (generated)",
                        flush=True,
                    )
                    continue

                fixture = static_extract_fixtures.get(format_name)
                if fixture is not None and fixture.exists():
                    source = ArchiveSource(
                        format=format_name,
                        path=fixture,
                        payload_bytes=None,
                        source_kind="fixture",
                    )
                    archive_sources[(format_name, codec_label)] = source
                    archive_sources_default.setdefault(format_name, source)
                    print(
                        f"[bench] prep ready {format_name} codec:{codec_label} (fixture)",
                        flush=True,
                    )
                else:
                    print(
                        f"[bench] prep unavailable {format_name} codec:{codec_label}",
                        flush=True,
                    )

    if "compress" in selected_commands:
        for format_name in selected_container_formats:
            input_path = compress_input_for_format(format_name)
            suffix = container_suffix(format_name)

            if "rom-weaver" in selected_archive_tools:
                if format_name in EXPECTED_COMPRESS_SKIPS:
                    for codec_label, _codec_value in rom_weaver_codec_cases_for_format(format_name):
                        rows.append(
                            skipped_row(
                                "compress",
                                format_codec_path_id(format_name, codec_label),
                                EXPECTED_COMPRESS_SKIPS[format_name],
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver",
                            )
                        )
                else:
                    for codec_label, codec_value in rom_weaver_codec_cases_for_format(format_name):
                        def make_command(
                            iteration: int,
                            warmup: bool,
                            format_value: str = format_name,
                            suffix_value: str = suffix,
                            input_value: Path = input_path,
                            codec_label_value: str = codec_label,
                            codec_value_override: str | None = codec_value,
                        ):
                            run_kind = "warmup" if warmup else "run"
                            output_path = (
                                outputs_dir
                                / "compress"
                                / f"{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}.{suffix_value}"
                            )
                            output_path.parent.mkdir(parents=True, exist_ok=True)
                            if output_path.exists():
                                output_path.unlink()
                            cmd = base_command(
                                args.bin,
                                rom_weaver_compress_args(
                                    input_path=input_value,
                                    format_name=format_value,
                                    output_path=output_path,
                                    threads=args.threads,
                                    codec_override=codec_value_override,
                                ),
                            )
                            return cmd, output_path

                        def processed_bytes(_context: Path, input_value: Path = input_path) -> int:
                            return input_value.stat().st_size

                        rows.append(
                            run_benchmark_case(
                                command="compress",
                                path_id=format_codec_path_id(format_name, codec_label),
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_command,
                                processed_bytes_factory=processed_bytes,
                                tool="rom-weaver",
                            )
                        )

            if "rom-weaver-wasm" in selected_archive_tools:
                assert node_bin is not None
                assert wasm_runner is not None
                assert wasm_module is not None
                if format_name in EXPECTED_COMPRESS_SKIPS:
                    for codec_label, _codec_value in rom_weaver_codec_cases_for_format(format_name):
                        rows.append(
                            skipped_row(
                                "compress",
                                format_codec_path_id(format_name, codec_label),
                                EXPECTED_COMPRESS_SKIPS[format_name],
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver-wasm",
                            )
                        )
                else:
                    for codec_label, codec_value in rom_weaver_codec_cases_for_format(format_name):
                        def make_wasm_command(
                            iteration: int,
                            warmup: bool,
                            format_value: str = format_name,
                            suffix_value: str = suffix,
                            input_value: Path = input_path,
                            codec_label_value: str = codec_label,
                            codec_value_override: str | None = codec_value,
                            node_bin_value: Path = node_bin,
                            wasm_runner_value: Path = wasm_runner,
                            wasm_module_value: Path = wasm_module,
                        ):
                            run_kind = "warmup" if warmup else "run"
                            output_path = (
                                outputs_dir
                                / "compress-wasm"
                                / f"{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}.{suffix_value}"
                            )
                            output_path.parent.mkdir(parents=True, exist_ok=True)
                            if output_path.exists():
                                output_path.unlink()
                            cmd = wasm_rom_weaver_command(
                                node_bin=node_bin_value,
                                wasm_runner=wasm_runner_value,
                                wasm_module=wasm_module_value,
                                args=rom_weaver_compress_args(
                                    input_path=input_value,
                                    format_name=format_value,
                                    output_path=output_path,
                                    threads=args.threads,
                                    codec_override=codec_value_override,
                                ),
                            )
                            return cmd, output_path

                        def processed_bytes(_context: Path, input_value: Path = input_path) -> int:
                            return input_value.stat().st_size

                        rows.append(
                            run_benchmark_case(
                                command="compress",
                                path_id=format_codec_path_id(format_name, codec_label),
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_wasm_command,
                                processed_bytes_factory=processed_bytes,
                                tool="rom-weaver-wasm",
                            )
                        )

            if "7zz" in selected_archive_tools:
                assert sevenzip_bin is not None
                if format_name not in SEVENZIP_COMPRESS_ONE_STEP:
                    rows.append(
                        skipped_row(
                            "compress",
                            f"format:{format_name}",
                            "7zz comparator unsupported for this compress format",
                            args.warmups,
                            args.iterations,
                            tool="7zz",
                        )
                    )
                    continue

                def make_sevenzip_compress_command(
                    iteration: int,
                    warmup: bool,
                    format_value: str = format_name,
                    suffix_value: str = suffix,
                    input_value: Path = input_path,
                    sevenzip_value: Path = sevenzip_bin,
                ):
                    run_kind = "warmup" if warmup else "run"
                    output_path = (
                        outputs_dir
                        / "compress-7zz"
                        / f"{token(format_value)}-{run_kind}-{iteration}.{suffix_value}"
                    )
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    if output_path.exists():
                        output_path.unlink()
                    cmd = sevenzip_compress_command(
                        sevenzip_bin=sevenzip_value,
                        format_name=format_value,
                        input_path=input_value,
                        output_path=output_path,
                        threads=args.threads,
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
                        command_factory=make_sevenzip_compress_command,
                        processed_bytes_factory=processed_bytes,
                        tool="7zz",
                    )
                )

    if "extract" in selected_commands:
        for format_name in selected_container_formats:
            if "rom-weaver" in selected_archive_tools:
                for codec_label, _codec_value in rom_weaver_codec_cases_for_format(format_name):
                    source = archive_sources.get((format_name, codec_label))
                    if source is None:
                        rows.append(
                            skipped_row(
                                "extract",
                                format_codec_path_id(format_name, codec_label),
                                "no valid source artifact available for this format+codec",
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver",
                            )
                        )
                        continue

                    def make_command(
                        iteration: int,
                        warmup: bool,
                        format_value: str = format_name,
                        codec_label_value: str = codec_label,
                        source_value: ArchiveSource = source,
                    ):
                        run_kind = "warmup" if warmup else "run"
                        out_dir = (
                            outputs_dir
                            / "extract"
                            / f"{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}"
                        )
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
                            path_id=format_codec_path_id(format_name, codec_label),
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_command,
                            processed_bytes_factory=processed_bytes,
                                tool="rom-weaver",
                            )
                        )

            if "rom-weaver-wasm" in selected_archive_tools:
                assert node_bin is not None
                assert wasm_runner is not None
                assert wasm_module is not None
                for codec_label, _codec_value in rom_weaver_codec_cases_for_format(format_name):
                    source = archive_sources.get((format_name, codec_label))
                    if source is None:
                        rows.append(
                            skipped_row(
                                "extract",
                                format_codec_path_id(format_name, codec_label),
                                "no valid source artifact available for this format+codec",
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver-wasm",
                            )
                        )
                        continue

                    def make_wasm_extract_command(
                        iteration: int,
                        warmup: bool,
                        format_value: str = format_name,
                        codec_label_value: str = codec_label,
                        source_value: ArchiveSource = source,
                        node_bin_value: Path = node_bin,
                        wasm_runner_value: Path = wasm_runner,
                        wasm_module_value: Path = wasm_module,
                    ):
                        run_kind = "warmup" if warmup else "run"
                        out_dir = (
                            outputs_dir
                            / "extract-wasm"
                            / f"{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}"
                        )
                        if out_dir.exists():
                            shutil.rmtree(out_dir)
                        out_dir.mkdir(parents=True, exist_ok=True)
                        cmd = wasm_rom_weaver_command(
                            node_bin=node_bin_value,
                            wasm_runner=wasm_runner_value,
                            wasm_module=wasm_module_value,
                            args=[
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
                            path_id=format_codec_path_id(format_name, codec_label),
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_wasm_extract_command,
                            processed_bytes_factory=processed_bytes,
                            tool="rom-weaver-wasm",
                        )
                    )

            if "7zz" in selected_archive_tools:
                assert sevenzip_bin is not None
                source = archive_sources_default.get(format_name)
                if source is None:
                    rows.append(
                        skipped_row(
                            "extract",
                            f"format:{format_name}",
                            "no valid source artifact available for this format",
                            args.warmups,
                            args.iterations,
                            tool="7zz",
                        )
                    )
                    continue
                if format_name not in SEVENZIP_EXTRACT_FORMATS:
                    rows.append(
                        skipped_row(
                            "extract",
                            f"format:{format_name}",
                            "7zz comparator unsupported for this extract format",
                            args.warmups,
                            args.iterations,
                            tool="7zz",
                        )
                    )
                    continue

                def make_sevenzip_extract_command(
                    iteration: int,
                    warmup: bool,
                    format_value: str = format_name,
                    source_value: ArchiveSource = source,
                    sevenzip_value: Path = sevenzip_bin,
                ):
                    run_kind = "warmup" if warmup else "run"
                    out_dir = outputs_dir / "extract-7zz" / f"{token(format_value)}-{run_kind}-{iteration}"
                    if out_dir.exists():
                        shutil.rmtree(out_dir)
                    out_dir.mkdir(parents=True, exist_ok=True)
                    cmd = sevenzip_extract_command(
                        sevenzip_bin=sevenzip_value,
                        format_name=format_value,
                        source_path=source_value.path,
                        output_dir=out_dir,
                        threads=args.threads,
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
                        command_factory=make_sevenzip_extract_command,
                        processed_bytes_factory=processed_bytes,
                        tool="7zz",
                    )
                )

    if "checksum" in selected_commands:
        if "raw" in selected_checksum_modes:
            ensure_source_fixture()
            for algorithm in selected_checksum_algorithms:

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

        if "auto-extract" in selected_checksum_modes:
            for format_name in selected_container_formats:
                source = archive_sources_default.get(format_name)
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
        for format_name in selected_patch_formats:
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
                ensure_dldi_fixtures()
                patch_original = dldi_original_path
                patch_modified = dldi_modified_path
            elif format_name in {"ips", "ebp"}:
                ensure_ips_ebp_fixtures()
                patch_original = ips_ebp_original_path
                patch_modified = ips_ebp_modified_path
            else:
                ensure_patch_pair_fixtures()
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
        for format_name in selected_patch_formats:
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
            "archive_tools": selected_archive_tools,
            "sevenzip_bin": str(sevenzip_bin) if sevenzip_bin is not None else None,
            "node_bin": str(node_bin) if node_bin is not None else None,
            "wasm_runner": str(wasm_runner) if wasm_runner is not None else None,
            "wasm_module": str(wasm_module) if wasm_module is not None else None,
            "commands": sorted(selected_commands),
            "container_formats": selected_container_formats,
            "patch_formats": selected_patch_formats,
            "checksum_algorithms": selected_checksum_algorithms,
            "checksum_modes": sorted(selected_checksum_modes),
            "rar_fixture": str(args.rar_fixture),
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
