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
import hashlib
import json
import os
import platform
import random
import select
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
BENCH_DEFAULTS_PATH = REPO_ROOT / "scripts" / "bench-defaults.json"
CACHE_SCHEMA_VERSION = 1


def load_benchmark_defaults() -> dict[str, Any]:
    try:
        return json.loads(BENCH_DEFAULTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"failed to load shared benchmark defaults {BENCH_DEFAULTS_PATH}: {error}") from error


BENCH_DEFAULTS = load_benchmark_defaults()
COMMAND_PATHS_DEFAULTS = BENCH_DEFAULTS["command_paths"]
DEFAULT_COMMANDS = str(COMMAND_PATHS_DEFAULTS["commands"])
DEFAULT_SIZE_MIB = int(COMMAND_PATHS_DEFAULTS["size_mib"])
DEFAULT_PATCH_SIZE_MIB = int(COMMAND_PATHS_DEFAULTS["patch_size_mib"])
DEFAULT_BENCH_FORMATS = [str(value) for value in COMMAND_PATHS_DEFAULTS["container_formats_default"]]
DEFAULT_BENCH_FORMATS_CSV = ",".join(DEFAULT_BENCH_FORMATS)
DEFAULT_ARCHIVE_TOOLS = str(COMMAND_PATHS_DEFAULTS["archive_tools"])
CHECKSUM_MODE_VALUES = ["raw", "auto-extract", "archive-no-extract"]
CONTAINER_FORMAT_ALIASES = {"z3d3": "z3ds"}
DEFAULT_CHECKSUM_COMBO_ALGOS = [
    str(value) for value in COMMAND_PATHS_DEFAULTS["checksum_combo_algorithms"]
]
DEFAULT_CHECKSUM_COMBO_ALGOS_CSV = ",".join(DEFAULT_CHECKSUM_COMBO_ALGOS)
CONTAINER_FORMATS = [str(value) for value in COMMAND_PATHS_DEFAULTS["container_formats"]]

CONTAINER_SUFFIX = {
    "tar.gz": "tar.gz",
    "tar.bz2": "tar.bz2",
    "tar.xz": "tar.xz",
}

ARCHIVE_TOOLS = ["rom-weaver", "rom-weaver-wasm", "7zz", "chdman", "dolphin-tool"]

EXPECTED_COMPRESS_SKIPS = {
    str(key): str(value)
    for key, value in COMMAND_PATHS_DEFAULTS["expected_compress_skips"].items()
}

EXPECTED_PATCH_CREATE_SKIPS = {
    str(key): str(value)
    for key, value in COMMAND_PATHS_DEFAULTS["expected_patch_create_skips"].items()
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

CHDMAN_COMPRESS_FORMATS = {"chd"}
CHDMAN_EXTRACT_FORMATS = {"chd"}
CHDMAN_CHECKSUM_AUTO_EXTRACT_FORMATS = {"chd"}

DOLPHIN_TOOL_COMPRESS_FORMATS = {"rvz"}
DOLPHIN_TOOL_EXTRACT_FORMATS = {"rvz"}
DOLPHIN_TOOL_CHECKSUM_AUTO_EXTRACT_FORMATS = {"rvz"}

DISC_COMPRESS_INPUT_FORMATS = {
    str(value) for value in COMMAND_PATHS_DEFAULTS["disc_compress_input_formats"]
}

ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT = {
    str(key): str(value)
    for key, value in COMMAND_PATHS_DEFAULTS["compress_codec_by_format"].items()
}

# Codec matrix for rom-weaver format/codec coverage.
# Entry tuples are (codec_label, codec_cli_value).
# zipx intentionally stays out of this matrix to avoid counting it in permutation totals.
ROM_WEAVER_CODEC_MATRIX_BY_FORMAT = {
    str(format_name): [(str(label), str(codec) if codec is not None else None) for label, codec in cases]
    for format_name, cases in COMMAND_PATHS_DEFAULTS["codec_matrix_by_format"].items()
}
CONTAINER_CODEC_LABEL_FILTER: set[str] | None = None

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

CHECKSUM_ALGORITHMS = [
    str(value) for value in COMMAND_PATHS_DEFAULTS["checksum_algorithms"]
]

PATCH_FORMATS = [str(value) for value in COMMAND_PATHS_DEFAULTS["patch_formats"]]

PATCH_EXTENSION = {
    str(key): str(value)
    for key, value in COMMAND_PATHS_DEFAULTS["patch_extension"].items()
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
    from_cache: bool = False


@dataclass
class BenchmarkCache:
    path: Path
    mode: str
    namespaces_by_tool: dict[str, str]
    entries: dict[str, dict[str, Any]]
    hit_count: int = 0
    write_count: int = 0

    @property
    def can_read(self) -> bool:
        return self.mode == "readwrite"

    @property
    def can_write(self) -> bool:
        return self.mode in {"readwrite", "refresh"}

    def _key(self, *, tool: str, command: str, path_id: str) -> str:
        namespace = self.namespaces_by_tool.get(tool, "unknown")
        return f"{namespace}|{tool}|{command}|{path_id}"

    def load_row(self, *, tool: str, command: str, path_id: str) -> BenchmarkRow | None:
        if not self.can_read:
            return None
        payload = self.entries.get(self._key(tool=tool, command=command, path_id=path_id))
        if payload is None:
            return None
        self.hit_count += 1
        return benchmark_row_from_cache_payload(payload)

    def store_row(self, row: BenchmarkRow) -> None:
        if not self.can_write:
            return
        payload = benchmark_row_to_cache_payload(row)
        key = self._key(tool=row.tool, command=row.command, path_id=row.path_id)
        self.entries[key] = payload
        self.write_count += 1

    def save(self) -> None:
        if not self.can_write:
            return
        payload = {
            "schema_version": CACHE_SCHEMA_VERSION,
            "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            "entries": self.entries,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def benchmark_row_to_cache_payload(row: BenchmarkRow) -> dict[str, Any]:
    return {
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


def benchmark_row_from_cache_payload(payload: dict[str, Any]) -> BenchmarkRow:
    samples = [
        TrialSample(
            elapsed_s=float(sample["elapsed_s"]),
            peak_rss_bytes=(int(sample["peak_rss_bytes"]) if sample.get("peak_rss_bytes") is not None else None),
            processed_bytes=(int(sample["processed_bytes"]) if sample.get("processed_bytes") is not None else None),
        )
        for sample in payload.get("samples", [])
    ]
    return BenchmarkRow(
        command=str(payload.get("command", "")),
        path_id=str(payload.get("path_id", "")),
        status=str(payload.get("status", "failed")),
        reason=payload.get("reason"),
        command_example=payload.get("command_example"),
        iterations=int(payload.get("iterations", 0)),
        warmups=int(payload.get("warmups", 0)),
        samples=samples,
        tool=str(payload.get("tool", "rom-weaver")),
        from_cache=True,
    )


class BrowserWasmJsonRunner:
    def __init__(self, *, node_bin: Path, wasm_runner: Path, wasm_module: Path) -> None:
        self._cmd_prefix = [
            str(node_bin),
            "--no-warnings",
            str(wasm_runner),
            "--stdin-json",
            "--wasm-module",
            str(wasm_module),
        ]
        self._proc = subprocess.Popen(
            self._cmd_prefix,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if self._proc.stdin is None or self._proc.stdout is None or self._proc.stderr is None:
            raise RuntimeError("failed to open browser wasm runner stdio pipes")
        self._wait_until_ready(timeout_sec=180)

    def _wait_until_ready(self, timeout_sec: int) -> None:
        line = self._readline_with_timeout(timeout_sec)
        if line is None:
            self.close()
            raise RuntimeError(f"browser wasm runner failed to initialize within {timeout_sec}s")
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as error:
            self.close()
            raise RuntimeError(f"browser wasm runner emitted invalid ready payload: {line}") from error
        if payload.get("ready") is not True:
            self.close()
            raise RuntimeError(f"browser wasm runner did not emit ready=true: {payload}")

    def _readline_with_timeout(self, timeout_sec: int) -> str | None:
        assert self._proc.stdout is not None
        if timeout_sec <= 0:
            timeout_sec = 1
        ready, _, _ = select.select([self._proc.stdout], [], [], timeout_sec)
        if not ready:
            return None
        line = self._proc.stdout.readline()
        if line == "":
            return None
        return line.rstrip("\n")

    def command_example(self, args: list[str]) -> list[str]:
        return [*self._cmd_prefix, "--", *args]

    def run(self, *, args: list[str], timeout_sec: int) -> RunOutcome:
        assert self._proc.stdin is not None
        payload = {"args": args}
        started = time.perf_counter()
        try:
            self._proc.stdin.write(json.dumps(payload) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            elapsed = time.perf_counter() - started
            return RunOutcome(
                elapsed_s=elapsed,
                peak_rss_bytes=None,
                exit_code=1,
                stdout="",
                stderr=f"browser wasm runner pipe write failed: {error}",
            )

        line = self._readline_with_timeout(timeout_sec)
        elapsed = time.perf_counter() - started
        if line is None:
            self.close()
            return RunOutcome(
                elapsed_s=elapsed,
                peak_rss_bytes=None,
                exit_code=124,
                stdout="",
                stderr=f"timed out after {timeout_sec}s",
            )

        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            return RunOutcome(
                elapsed_s=elapsed,
                peak_rss_bytes=None,
                exit_code=1,
                stdout=line,
                stderr=f"browser wasm runner returned invalid json: {error}",
            )

        response_elapsed = response.get("elapsedS")
        if isinstance(response_elapsed, (int, float)) and response_elapsed >= 0:
            elapsed = float(response_elapsed)
        ok = bool(response.get("ok"))
        exit_code_raw = response.get("exitCode", 0 if ok else 1)
        exit_code = int(exit_code_raw) if isinstance(exit_code_raw, (int, float)) else (0 if ok else 1)
        message = str(response.get("message") or "")
        return RunOutcome(
            elapsed_s=elapsed,
            peak_rss_bytes=None,
            exit_code=exit_code,
            stdout=line,
            stderr=message,
        )

    def close(self) -> None:
        if self._proc.poll() is not None:
            return
        try:
            if self._proc.stdin is not None and not self._proc.stdin.closed:
                self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


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
    parser.add_argument(
        "--size-mib",
        type=int,
        default=DEFAULT_SIZE_MIB,
        help=f"Source fixture size in MiB (default: {DEFAULT_SIZE_MIB})",
    )
    parser.add_argument(
        "--patch-size-mib",
        type=int,
        default=DEFAULT_PATCH_SIZE_MIB,
        help=f"Patch original/modified fixture size in MiB (default: {DEFAULT_PATCH_SIZE_MIB})",
    )
    parser.add_argument("--threads", type=int, default=4, help="Thread count passed to CLI commands")
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
        default=DEFAULT_COMMANDS,
        help=f"Comma-separated subset of commands to run (default: {DEFAULT_COMMANDS})",
    )
    parser.add_argument(
        "--container-formats",
        default=DEFAULT_BENCH_FORMATS_CSV,
        help=(
            "Comma-separated subset of container formats for compress/extract/checksum paths "
            f"(default: {DEFAULT_BENCH_FORMATS_CSV}; alias: z3d3 -> z3ds)"
        ),
    )
    parser.add_argument(
        "--container-codecs",
        default="all",
        help=(
            "Comma-separated subset of benchmark codec labels for container compress/extract paths "
            "(for example: zstd,store). Use all to run every configured codec label."
        ),
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
        default=str(COMMAND_PATHS_DEFAULTS["checksum_modes"]),
        help=(
            "Checksum paths to run: raw, auto-extract, archive-no-extract, or a comma-separated subset "
            "(default: raw)"
        ),
    )
    parser.add_argument(
        "--checksum-combo-algos",
        default=DEFAULT_CHECKSUM_COMBO_ALGOS_CSV,
        help=(
            "Comma-separated algorithms for one special multi-algorithm checksum run on raw input. "
            "Use 'none' to disable (default: crc32,md5,sha1)"
        ),
    )
    parser.add_argument(
        "--rar-fixture",
        type=Path,
        default=Path("tests/fixtures/rar/version.rar"),
        help="RAR fixture path used when rar create is unavailable (default: tests/fixtures/rar/version.rar)",
    )
    parser.add_argument(
        "--chd-fixture",
        type=Path,
        default=None,
        help="Optional CHD fixture path used for extract/checksum source archives",
    )
    parser.add_argument(
        "--rvz-fixture",
        type=Path,
        default=None,
        help="Optional RVZ fixture path used for extract/checksum source archives",
    )
    parser.add_argument(
        "--source-bin-fixture",
        type=Path,
        default=None,
        help="Optional raw binary source fixture used for non-disc compress inputs",
    )
    parser.add_argument(
        "--source-disc-fixture",
        type=Path,
        default=None,
        help="Optional disc ISO source fixture used for disc compress inputs (rvz/wia/wbfs/tgc)",
    )
    parser.add_argument(
        "--archive-tools",
        default=DEFAULT_ARCHIVE_TOOLS,
        help=(
            "Archive benchmark tools to run for compress/extract "
            "(rom-weaver,rom-weaver-wasm,7zz,chdman,dolphin-tool). "
            "Use 'auto' to benchmark all available tools (default: auto)"
        ),
    )
    parser.add_argument(
        "--cache-file",
        type=Path,
        default=Path("target/bench-command-paths-cache.json"),
        help="Per-case benchmark cache JSON path (default: target/bench-command-paths-cache.json)",
    )
    parser.add_argument(
        "--cache-mode",
        choices=["off", "readwrite", "refresh"],
        default="readwrite",
        help=(
            "Benchmark cache mode: off disables cache, readwrite reuses and updates cache, "
            "refresh reruns everything and writes updated results (default: readwrite)"
        ),
    )
    parser.add_argument(
        "--fixture-cache-dir",
        type=Path,
        default=Path(f"target/bench-fixtures/command-paths-v{BENCH_DEFAULTS['fixture_cache_version']}"),
        help=(
            "Persistent generated fixture cache directory. Generated 128 MiB fixtures are hard-linked "
            "or copied from here into the per-run work directory (default: target/bench-fixtures/command-paths-vN)"
        ),
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
        help=(
            "Path to wasm runner wrapper script used for rom-weaver-wasm archive tool "
            "(Node WASI default: scripts/wasm/run-wasi-cli.mjs; browser wasm option: scripts/wasm/run-browser-cli.mjs)"
        ),
    )
    parser.add_argument(
        "--wasm-module",
        type=Path,
        default=Path("packages/rom-weaver-webapp/src/wasm/rom-weaver-app.wasm"),
        help="Path to rom-weaver app wasm module used for rom-weaver-wasm archive tool",
    )
    parser.add_argument(
        "--browser-wasm-persistent-session",
        action="store_true",
        help=(
            "Experimental: keep scripts/wasm/run-browser-cli.mjs open as one browser session for "
            "rom-weaver-wasm rows. Disabled by default because browser startup can hang in some "
            "Playwright environments; Vitest browser benchmarks are the supported OPFS timing path."
        ),
    )
    parser.add_argument(
        "--chdman-bin",
        type=Path,
        default=Path(shutil.which("chdman") or "chdman"),
        help="Path to chdman binary used when archive-tools includes chdman (default: PATH lookup for chdman)",
    )
    parser.add_argument(
        "--dolphin-tool-bin",
        type=Path,
        default=Path(shutil.which("dolphin-tool") or shutil.which("dolphintool") or "dolphin-tool"),
        help=(
            "Path to dolphin-tool binary used when archive-tools includes dolphin-tool "
            "(default: PATH lookup for dolphin-tool/dolphintool)"
        ),
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


def parse_value_filter(
    raw: str,
    valid_values: list[str],
    flag_name: str,
    aliases: dict[str, str] | None = None,
) -> list[str]:
    values = [value.strip().lower() for value in raw.split(",") if value.strip()]
    if not values:
        raise ValueError(f"{flag_name} must include at least one value")
    if aliases:
        values = [aliases.get(value, value) for value in values]
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


def parse_archive_tool_filter(raw: str) -> tuple[str, list[str]]:
    values = [value.strip().lower() for value in raw.split(",") if value.strip()]
    if not values:
        raise ValueError("--archive-tools must include at least one value")
    value_set = set(values)
    if value_set <= {"auto", "all-available"}:
        return "auto", []
    if "auto" in value_set or "all-available" in value_set:
        raise ValueError("--archive-tools cannot mix auto/all-available with explicit values")
    selected = parse_value_filter(raw, ARCHIVE_TOOLS, "--archive-tools")
    return "explicit", selected


def parse_optional_checksum_combo_algos(raw: str) -> list[str]:
    trimmed = raw.strip().lower()
    if trimmed in {"", "none", "off", "false", "0"}:
        return []
    return parse_value_filter(raw, CHECKSUM_ALGORITHMS, "--checksum-combo-algos")


def parse_optional_container_codec_labels(raw: str) -> set[str] | None:
    trimmed = raw.strip().lower()
    if trimmed in {"", "all", "*"}:
        return None
    labels = {value.strip().lower() for value in raw.split(",") if value.strip()}
    if not labels:
        raise ValueError("--container-codecs must include at least one codec label")
    valid_labels = {
        label.strip().lower()
        for cases in ROM_WEAVER_CODEC_MATRIX_BY_FORMAT.values()
        for label, _codec in cases
    }
    valid_labels.update(codec.strip().lower() for codec in ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT.values())
    unknown_labels = sorted(label for label in labels if label not in valid_labels)
    if unknown_labels:
        valid_display = ", ".join(sorted(valid_labels))
        unknown_display = ", ".join(unknown_labels)
        raise ValueError(
            f"--container-codecs contains unknown label(s): {unknown_display}. "
            f"Known labels: {valid_display}"
        )
    return labels


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
    subprocess.run(["mise", "run", "build-wasm"], check=True, cwd=REPO_ROOT)


def resolve_external_binary(bin_path: Path, flag_name: str) -> Path:
    candidate = bin_path.expanduser()
    if candidate.exists():
        return candidate.resolve()
    resolved = shutil.which(str(candidate))
    if resolved is not None:
        return Path(resolved)
    raise SystemExit(f"{flag_name} binary not found: {bin_path}")


def try_resolve_external_binary(bin_path: Path) -> Path | None:
    candidate = bin_path.expanduser()
    if candidate.exists():
        return candidate.resolve()
    resolved = shutil.which(str(candidate))
    if resolved is not None:
        return Path(resolved).resolve()
    return None


def file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def file_fingerprint(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    resolved = path.expanduser().resolve()
    if not resolved.exists():
        return {"path": str(resolved), "exists": False}
    stat_result = resolved.stat()
    return {
        "path": str(resolved),
        "exists": True,
        "size": stat_result.st_size,
        "mtime_ns": stat_result.st_mtime_ns,
    }


def load_cache_entries(cache_file: Path) -> dict[str, dict[str, Any]]:
    if not cache_file.exists():
        return {}
    try:
        payload = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    if payload.get("schema_version") != CACHE_SCHEMA_VERSION:
        return {}
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for key, value in entries.items():
        if isinstance(key, str) and isinstance(value, dict):
            normalized[key] = value
    return normalized


def tool_cache_namespace(
    *,
    tool: str,
    tool_fingerprint_payload: dict[str, Any] | None,
    args: argparse.Namespace,
    checksum_combo_algorithms: list[str],
) -> str:
    payload = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "tool": tool,
        "script_sha256": file_sha256(SCRIPT_PATH),
        "tool_fingerprint": tool_fingerprint_payload,
        "bench_config": {
            "size_mib": args.size_mib,
            "patch_size_mib": args.patch_size_mib,
            "threads": args.threads,
            "warmups": args.warmups,
            "iterations": args.iterations,
            "timeout_sec": args.timeout_sec,
            "checksum_combo_algos": checksum_combo_algorithms,
            "source_bin_fixture": file_fingerprint(args.source_bin_fixture),
            "source_disc_fixture": file_fingerprint(args.source_disc_fixture),
            "rar_fixture": file_fingerprint(args.rar_fixture),
            "chd_fixture": file_fingerprint(args.chd_fixture),
            "rvz_fixture": file_fingerprint(args.rvz_fixture),
        },
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return digest


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


def checksum_multi_algo_suffix(algorithms: list[str]) -> str:
    return "+".join(algorithms)


def checksum_multi_algo_args(algorithms: list[str]) -> list[str]:
    args: list[str] = []
    for algorithm in algorithms:
        args.extend(["--algo", algorithm])
    return args


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


def stage_fixture_file(source_path: Path, destination_path: Path) -> None:
    source_resolved = source_path.expanduser().resolve()
    if not source_resolved.exists():
        raise SystemExit(f"fixture file not found: {source_resolved}")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        destination_path.unlink()
    try:
        os.link(source_resolved, destination_path)
    except OSError:
        shutil.copy2(source_resolved, destination_path)


def write_test_gamecube_iso_fixture(path: Path, total_bytes: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    total_len = max(total_bytes, 0x440)
    image = bytearray(total_len)
    image[:6] = b"RWTEST"
    image[0x1C:0x20] = bytes([0xC2, 0x33, 0x9F, 0x3D])
    title = b"rom-weaver-bench\x00"
    image[0x20 : 0x20 + len(title)] = title
    for index in range(0x440, total_len):
        image[index] = index % 251
    path.write_bytes(image)


def write_modified_fixture(original: Path, modified: Path) -> None:
    modified.parent.mkdir(parents=True, exist_ok=True)
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


def cached_fixture_path(cache_dir: Path, label: str, size_bytes: int, seed: int | None = None, suffix: str = "bin") -> Path:
    seed_part = f"-seed-{seed:x}" if seed is not None else ""
    return cache_dir / f"{label}-{size_bytes}{seed_part}.{suffix}"


def ensure_cached_random_fixture(cache_dir: Path, label: str, size_bytes: int, seed: int) -> Path:
    cache_path = cached_fixture_path(cache_dir, label, size_bytes, seed)
    if cache_path.exists() and cache_path.stat().st_size == size_bytes:
        return cache_path
    if cache_path.exists():
        cache_path.unlink()
    print(f"[bench] generating fixture cache {cache_path}", flush=True)
    write_random_fixture(cache_path, size_bytes, seed)
    return cache_path


def ensure_cached_modified_fixture(cache_dir: Path, label: str, original: Path) -> Path:
    size_bytes = original.stat().st_size
    cache_path = cached_fixture_path(cache_dir, label, size_bytes, suffix="bin")
    if cache_path.exists() and cache_path.stat().st_size == size_bytes:
        return cache_path
    if cache_path.exists():
        cache_path.unlink()
    print(f"[bench] generating fixture cache {cache_path}", flush=True)
    write_modified_fixture(original, cache_path)
    return cache_path


def ensure_cached_gamecube_iso_fixture(cache_dir: Path, label: str, total_bytes: int) -> Path:
    expected_size = max(total_bytes, 0x440)
    cache_path = cached_fixture_path(cache_dir, label, expected_size, suffix="iso")
    if cache_path.exists() and cache_path.stat().st_size == expected_size:
        return cache_path
    if cache_path.exists():
        cache_path.unlink()
    print(f"[bench] generating fixture cache {cache_path}", flush=True)
    write_test_gamecube_iso_fixture(cache_path, total_bytes)
    return cache_path


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
        cases = list(codecs)
    else:
        default_codec = ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT.get(format_name)
        if default_codec is not None:
            cases = [(default_codec, default_codec)]
        else:
            cases = [("default", None)]
    if CONTAINER_CODEC_LABEL_FILTER is None:
        return cases
    return [
        (label, codec)
        for label, codec in cases
        if label.strip().lower() in CONTAINER_CODEC_LABEL_FILTER
    ]


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
        "--input",
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
    runner_args: list[str] | None = None,
) -> list[str]:
    cmd = [
        str(node_bin),
        "--no-warnings",
        str(wasm_runner),
    ]
    if runner_args:
        cmd.extend(runner_args)
    cmd.extend(
        [
            "--wasm-module",
            str(wasm_module),
            "--",
            *args,
        ]
    )
    return cmd


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


def chdman_command(chdman_bin: Path, args: list[str]) -> list[str]:
    return [str(chdman_bin), *args]


def chdman_compress_command(
    *,
    chdman_bin: Path,
    format_name: str,
    input_path: Path,
    output_path: Path,
    threads: int,
) -> list[str]:
    if format_name not in CHDMAN_COMPRESS_FORMATS:
        raise ValueError(f"chdman compress is not configured for format: {format_name}")
    return chdman_command(
        chdman_bin,
        [
            "createhd",
            "-f",
            "-np",
            str(max(1, threads)),
            "-i",
            str(input_path),
            "-o",
            str(output_path),
        ],
    )


def chdman_extract_command(
    *,
    chdman_bin: Path,
    format_name: str,
    source_path: Path,
    output_path: Path,
) -> list[str]:
    if format_name not in CHDMAN_EXTRACT_FORMATS:
        raise ValueError(f"chdman extract is not configured for format: {format_name}")
    return chdman_command(
        chdman_bin,
        [
            "extracthd",
            "-f",
            "-i",
            str(source_path),
            "-o",
            str(output_path),
        ],
    )


def dolphin_tool_command(dolphin_tool_bin: Path, args: list[str]) -> list[str]:
    return [str(dolphin_tool_bin), *args]


def dolphin_tool_rvz_compress_command(
    *,
    dolphin_tool_bin: Path,
    format_name: str,
    input_path: Path,
    output_path: Path,
    user_dir: Path,
) -> list[str]:
    if format_name not in DOLPHIN_TOOL_COMPRESS_FORMATS:
        raise ValueError(f"dolphin-tool compress is not configured for format: {format_name}")
    return dolphin_tool_command(
        dolphin_tool_bin,
        [
            "convert",
            "-u",
            str(user_dir),
            "-i",
            str(input_path),
            "-o",
            str(output_path),
            "-f",
            "rvz",
            "-c",
            "zstd",
            "-l",
            "5",
            "-b",
            "131072",
        ],
    )


def dolphin_tool_rvz_extract_command(
    *,
    dolphin_tool_bin: Path,
    format_name: str,
    source_path: Path,
    output_path: Path,
    user_dir: Path,
) -> list[str]:
    if format_name not in DOLPHIN_TOOL_EXTRACT_FORMATS:
        raise ValueError(f"dolphin-tool extract is not configured for format: {format_name}")
    return dolphin_tool_command(
        dolphin_tool_bin,
        [
            "convert",
            "-u",
            str(user_dir),
            "-i",
            str(source_path),
            "-o",
            str(output_path),
            "-f",
            "iso",
        ],
    )


def chdman_verify_command(
    *,
    chdman_bin: Path,
    format_name: str,
    source_path: Path,
) -> list[str]:
    if format_name not in CHDMAN_CHECKSUM_AUTO_EXTRACT_FORMATS:
        raise ValueError(f"chdman checksum is not configured for format: {format_name}")
    return chdman_command(
        chdman_bin,
        [
            "verify",
            "-i",
            str(source_path),
        ],
    )


def dolphin_tool_verify_command(
    *,
    dolphin_tool_bin: Path,
    format_name: str,
    source_path: Path,
    user_dir: Path,
) -> list[str]:
    if format_name not in DOLPHIN_TOOL_CHECKSUM_AUTO_EXTRACT_FORMATS:
        raise ValueError(f"dolphin-tool checksum is not configured for format: {format_name}")
    return dolphin_tool_command(
        dolphin_tool_bin,
        [
            "verify",
            "-u",
            str(user_dir),
            "-i",
            str(source_path),
            "-a",
            "sha1",
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
        "from_cache": row.from_cache,
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
    cache: BenchmarkCache | None = None,
) -> BenchmarkRow:
    if cache is not None:
        cached_row = cache.load_row(tool=tool, command=command, path_id=path_id)
        if cached_row is not None:
            print(f"[bench] cache hit {tool} {command} {path_id}", flush=True)
            return cached_row

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
            row = BenchmarkRow(
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
            if cache is not None:
                cache.store_row(row)
            return row
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
            row = BenchmarkRow(
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
            if cache is not None:
                cache.store_row(row)
            return row
        processed_bytes = processed_bytes_factory(context)
        samples.append(
            TrialSample(
                elapsed_s=outcome.elapsed_s,
                peak_rss_bytes=outcome.peak_rss_bytes,
                processed_bytes=processed_bytes,
            )
        )

    print(f"[bench] done {tool} {command} {path_id}", flush=True)
    row = BenchmarkRow(
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
    if cache is not None:
        cache.store_row(row)
    return row


def run_benchmark_case_browser_runner(
    *,
    command: str,
    path_id: str,
    warmups: int,
    iterations: int,
    timeout_sec: int,
    args_factory,
    processed_bytes_factory,
    runner: BrowserWasmJsonRunner,
    tool: str = "rom-weaver-wasm",
    cache: BenchmarkCache | None = None,
) -> BenchmarkRow:
    if cache is not None:
        cached_row = cache.load_row(tool=tool, command=command, path_id=path_id)
        if cached_row is not None:
            print(f"[bench] cache hit {tool} {command} {path_id}", flush=True)
            return cached_row

    samples: list[TrialSample] = []
    command_example: list[str] | None = None
    print(f"[bench] start {tool} {command} {path_id}", flush=True)

    for warmup_index in range(warmups):
        command_args, context = args_factory(warmup_index, True)
        command_example = runner.command_example(command_args)
        outcome = runner.run(args=command_args, timeout_sec=timeout_sec)
        if outcome.exit_code != 0:
            reason = f"warmup failed (exit {outcome.exit_code})"
            tail = outcome_tail_message(outcome)
            if tail:
                reason = f"{reason}: {tail}"
            print(f"[bench] failed {command} {path_id}: {reason}", flush=True)
            row = BenchmarkRow(
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
            if cache is not None:
                cache.store_row(row)
            return row
        _ = processed_bytes_factory(context)

    for iteration in range(iterations):
        command_args, context = args_factory(iteration, False)
        command_example = runner.command_example(command_args)
        outcome = runner.run(args=command_args, timeout_sec=timeout_sec)
        if outcome.exit_code != 0:
            reason = f"iteration {iteration + 1} failed (exit {outcome.exit_code})"
            tail = outcome_tail_message(outcome)
            if tail:
                reason = f"{reason}: {tail}"
            print(f"[bench] failed {command} {path_id}: {reason}", flush=True)
            row = BenchmarkRow(
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
            if cache is not None:
                cache.store_row(row)
            return row
        processed_bytes = processed_bytes_factory(context)
        samples.append(
            TrialSample(
                elapsed_s=outcome.elapsed_s,
                peak_rss_bytes=outcome.peak_rss_bytes,
                processed_bytes=processed_bytes,
            )
        )

    print(f"[bench] done {tool} {command} {path_id}", flush=True)
    row = BenchmarkRow(
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
    if cache is not None:
        cache.store_row(row)
    return row


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
    print(
        "tool         command       path_id                         status      cached  elapsed_avg_s  peak_rss_max_mib  throughput_avg_mib_s"
    )
    print(
        "-----------  ------------  ------------------------------  ----------  ------  -------------  ----------------  ---------------------"
    )
    for row in rows:
        metrics = row.get("metrics") or {}
        elapsed_avg = metrics.get("elapsed_avg_s")
        peak_rss = metrics.get("peak_rss_max_mib")
        throughput = metrics.get("throughput_avg_mib_s")
        cached = "yes" if row.get("from_cache") else "no"
        elapsed_text = f"{elapsed_avg:>13.4f}" if isinstance(elapsed_avg, (int, float)) else " " * 13 + "-"
        peak_text = f"{peak_rss:>16.2f}" if isinstance(peak_rss, (int, float)) else " " * 16 + "-"
        thr_text = f"{throughput:>21.2f}" if isinstance(throughput, (int, float)) else " " * 21 + "-"
        print(
            f"{row.get('tool', 'rom-weaver'):<11}  {row['command']:<12}  {row['path_id']:<30}  {row['status']:<10}  {cached:<6}  {elapsed_text}  {peak_text}  {thr_text}"
        )


def main() -> None:
    global CONTAINER_CODEC_LABEL_FILTER
    args = parse_args()
    selected_commands = parse_command_filter(args.commands)
    archive_tool_mode, explicit_archive_tools = parse_archive_tool_filter(args.archive_tools)
    selected_container_formats = parse_value_filter(
        args.container_formats,
        CONTAINER_FORMATS,
        "--container-formats",
        aliases=CONTAINER_FORMAT_ALIASES,
    )
    CONTAINER_CODEC_LABEL_FILTER = parse_optional_container_codec_labels(args.container_codecs)
    selected_patch_formats = parse_value_filter(args.patch_formats, PATCH_FORMATS, "--patch-formats")
    selected_checksum_algorithms = parse_value_filter(args.checksum_algos, CHECKSUM_ALGORITHMS, "--checksum-algos")
    checksum_combo_algorithms = parse_optional_checksum_combo_algos(args.checksum_combo_algos)
    selected_checksum_modes = set(parse_value_filter(args.checksum_modes, CHECKSUM_MODE_VALUES, "--checksum-modes"))
    needs_archive_sources = ("extract" in selected_commands) or (
        "checksum" in selected_commands and "auto-extract" in selected_checksum_modes
    ) or ("checksum" in selected_commands and "archive-no-extract" in selected_checksum_modes)

    if args.size_mib <= 0 or args.patch_size_mib <= 0:
        raise SystemExit("--size-mib and --patch-size-mib must be positive integers")
    if args.threads <= 0 or args.warmups < 0 or args.iterations <= 0:
        raise SystemExit("--threads must be > 0, --warmups >= 0, and --iterations > 0")

    requested_archive_tools = list(ARCHIVE_TOOLS) if archive_tool_mode == "auto" else list(explicit_archive_tools)
    needs_rom_weaver = (
        "rom-weaver" in requested_archive_tools
        or "rom-weaver-wasm" in requested_archive_tools
        or needs_archive_sources
        or "checksum" in selected_commands
        or "patch-create" in selected_commands
        or "patch-apply" in selected_commands
    )
    rebuild_release_and_wasm(args.skip_build, needs_rom_weaver)
    resolved_native_bin = args.bin.expanduser()
    if needs_rom_weaver:
        ensure_binary(args.bin, args.skip_build)
        resolved_native_bin = resolved_native_bin.resolve()
        args.bin = resolved_native_bin

    selected_archive_tools: list[str]
    sevenzip_bin: Path | None = None
    chdman_bin: Path | None = None
    dolphin_tool_bin: Path | None = None
    node_bin: Path | None = None
    wasm_runner: Path | None = None
    wasm_module: Path | None = None

    if archive_tool_mode == "auto":
        selected_archive_tools = ["rom-weaver"]
        node_candidate = try_resolve_external_binary(args.node_bin)
        wasm_runner_candidate = args.wasm_runner.expanduser().resolve()
        wasm_module_candidate = args.wasm_module.expanduser().resolve()
        if node_candidate is not None and wasm_runner_candidate.exists() and wasm_module_candidate.exists():
            node_bin = node_candidate
            wasm_runner = wasm_runner_candidate
            wasm_module = wasm_module_candidate
            selected_archive_tools.append("rom-weaver-wasm")
        else:
            print("[bench] auto skip rom-weaver-wasm (missing node, wasm runner, or wasm module)", flush=True)

        sevenzip_bin = try_resolve_external_binary(args.sevenzip_bin)
        if sevenzip_bin is not None:
            selected_archive_tools.append("7zz")
        else:
            print("[bench] auto skip 7zz (binary not found)", flush=True)

        chdman_bin = try_resolve_external_binary(args.chdman_bin)
        if chdman_bin is not None:
            selected_archive_tools.append("chdman")
        else:
            print("[bench] auto skip chdman (binary not found)", flush=True)

        dolphin_tool_bin = try_resolve_external_binary(args.dolphin_tool_bin)
        if dolphin_tool_bin is not None:
            selected_archive_tools.append("dolphin-tool")
        else:
            print("[bench] auto skip dolphin-tool (binary not found)", flush=True)
    else:
        selected_archive_tools = explicit_archive_tools
        if "7zz" in selected_archive_tools:
            sevenzip_bin = resolve_external_binary(args.sevenzip_bin, "--sevenzip-bin")
        if "chdman" in selected_archive_tools:
            chdman_bin = resolve_external_binary(args.chdman_bin, "--chdman-bin")
        if "dolphin-tool" in selected_archive_tools:
            dolphin_tool_bin = resolve_external_binary(args.dolphin_tool_bin, "--dolphin-tool-bin")
        if "rom-weaver-wasm" in selected_archive_tools:
            node_bin = resolve_external_binary(args.node_bin, "--node-bin")
            wasm_runner = args.wasm_runner.expanduser().resolve()
            if not wasm_runner.exists():
                raise SystemExit(f"--wasm-runner file not found: {wasm_runner}")
            wasm_module = args.wasm_module.expanduser().resolve()
            if not wasm_module.exists():
                raise SystemExit(f"--wasm-module file not found: {wasm_module}")

    print(f"[bench] archive tools: {', '.join(selected_archive_tools)}", flush=True)

    cache: BenchmarkCache | None = None
    if args.cache_mode != "off":
        cache_entries = load_cache_entries(args.cache_file)
        namespaces_by_tool: dict[str, str] = {}
        if needs_rom_weaver:
            namespaces_by_tool["rom-weaver"] = tool_cache_namespace(
                tool="rom-weaver",
                tool_fingerprint_payload={"bin": file_fingerprint(resolved_native_bin)},
                args=args,
                checksum_combo_algorithms=checksum_combo_algorithms,
            )
        if "rom-weaver-wasm" in selected_archive_tools:
            namespaces_by_tool["rom-weaver-wasm"] = tool_cache_namespace(
                tool="rom-weaver-wasm",
                tool_fingerprint_payload={
                    "node_bin": file_fingerprint(node_bin),
                    "wasm_runner": file_fingerprint(wasm_runner),
                    "wasm_module": file_fingerprint(wasm_module),
                },
                args=args,
                checksum_combo_algorithms=checksum_combo_algorithms,
            )
        if sevenzip_bin is not None:
            namespaces_by_tool["7zz"] = tool_cache_namespace(
                tool="7zz",
                tool_fingerprint_payload={"sevenzip_bin": file_fingerprint(sevenzip_bin)},
                args=args,
                checksum_combo_algorithms=checksum_combo_algorithms,
            )
        if chdman_bin is not None:
            namespaces_by_tool["chdman"] = tool_cache_namespace(
                tool="chdman",
                tool_fingerprint_payload={"chdman_bin": file_fingerprint(chdman_bin)},
                args=args,
                checksum_combo_algorithms=checksum_combo_algorithms,
            )
        if dolphin_tool_bin is not None:
            namespaces_by_tool["dolphin-tool"] = tool_cache_namespace(
                tool="dolphin-tool",
                tool_fingerprint_payload={"dolphin_tool_bin": file_fingerprint(dolphin_tool_bin)},
                args=args,
                checksum_combo_algorithms=checksum_combo_algorithms,
            )
        cache = BenchmarkCache(
            path=args.cache_file.expanduser().resolve(),
            mode=args.cache_mode,
            namespaces_by_tool=namespaces_by_tool,
            entries=cache_entries,
        )
        print(f"[bench] cache mode={args.cache_mode} entries={len(cache_entries)} file={cache.path}", flush=True)

    work_dir = args.work_dir.resolve()
    fixture_cache_dir = args.fixture_cache_dir.expanduser().resolve()
    fixture_cache_dir.mkdir(parents=True, exist_ok=True)
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
    browser_wasm_json_runners: dict[Path, BrowserWasmJsonRunner] = {}
    browser_wasm_persistent_enabled = (
        args.browser_wasm_persistent_session
        and
        "rom-weaver-wasm" in selected_archive_tools
        and wasm_runner is not None
        and wasm_runner.name == "run-browser-cli.mjs"
    )
    if browser_wasm_persistent_enabled:
        assert node_bin is not None
        assert wasm_runner is not None
        print("[bench] browser wasm runner: persistent json session enabled", flush=True)

    def browser_runner_for_wasm_module(wasm_module_for_case: Path) -> BrowserWasmJsonRunner:
        assert node_bin is not None
        assert wasm_runner is not None
        runner = browser_wasm_json_runners.get(wasm_module_for_case)
        if runner is not None:
            return runner
        runner = BrowserWasmJsonRunner(
            node_bin=node_bin,
            wasm_runner=wasm_runner,
            wasm_module=wasm_module_for_case,
        )
        browser_wasm_json_runners[wasm_module_for_case] = runner
        ensure_source_fixture()
        warmup = runner.run(
            args=[
                "checksum",
                "--input",
                str(source_path),
                "--algo",
                "crc32",
                "--no-extract",
                "--threads",
                str(args.threads),
            ],
            timeout_sec=args.timeout_sec,
        )
        if warmup.exit_code == 0:
            print(
                f"[bench] browser wasm persistent session warmup complete ({wasm_module_for_case.name})",
                flush=True,
            )
        else:
            tail = outcome_tail_message(warmup) or "warmup failed"
            print(
                f"[bench] browser wasm warmup failed ({wasm_module_for_case.name}): {tail}",
                flush=True,
            )
        return runner

    def ensure_source_fixture() -> None:
        nonlocal source_ready
        if source_ready:
            return
        if args.source_bin_fixture is not None:
            stage_fixture_file(args.source_bin_fixture, source_path)
            print(f"[bench] using source-bin fixture: {args.source_bin_fixture}", flush=True)
        else:
            cached = ensure_cached_random_fixture(
                fixture_cache_dir,
                "source",
                args.size_mib * MIB,
                seed=0xBADC0DE,
            )
            stage_fixture_file(cached, source_path)
        source_ready = True

    def ensure_disc_source_fixture() -> None:
        nonlocal disc_source_ready
        if disc_source_ready:
            return
        if args.source_disc_fixture is not None:
            stage_fixture_file(args.source_disc_fixture, disc_source_path)
            print(f"[bench] using source-disc fixture: {args.source_disc_fixture}", flush=True)
        else:
            cached = ensure_cached_gamecube_iso_fixture(
                fixture_cache_dir,
                "source-disc",
                args.size_mib * MIB,
            )
            stage_fixture_file(cached, disc_source_path)
        disc_source_ready = True

    def ensure_patch_pair_fixtures() -> None:
        nonlocal patch_pair_ready
        if patch_pair_ready:
            return
        cached_original = ensure_cached_random_fixture(
            fixture_cache_dir,
            "patch-original",
            args.patch_size_mib * MIB,
            seed=0xC0FFEE,
        )
        cached_modified = ensure_cached_modified_fixture(
            fixture_cache_dir,
            "patch-modified",
            cached_original,
        )
        stage_fixture_file(cached_original, original_path)
        stage_fixture_file(cached_modified, modified_path)
        patch_pair_ready = True

    def ensure_ips_ebp_fixtures() -> None:
        nonlocal ips_ebp_ready
        if ips_ebp_ready:
            return
        ips_ebp_size_bytes = min(args.patch_size_mib * MIB, IPS_EBP_BENCH_MAX_BYTES)
        cached_original = ensure_cached_random_fixture(
            fixture_cache_dir,
            "ips-ebp-original",
            ips_ebp_size_bytes,
            seed=0x1BADB002,
        )
        cached_modified = ensure_cached_modified_fixture(
            fixture_cache_dir,
            "ips-ebp-modified",
            cached_original,
        )
        stage_fixture_file(cached_original, ips_ebp_original_path)
        stage_fixture_file(cached_modified, ips_ebp_modified_path)
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
                    "patch",
                    "apply",
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
                "patch",
                "create",
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

    large_limit_validation_formats = {"ips", "ebp"} - set(EXPECTED_PATCH_CREATE_SKIPS)
    if "patch-create" in selected_commands and large_limit_validation_formats & set(selected_patch_formats):
        ensure_patch_pair_fixtures()
        if original_path.stat().st_size > IPS_CREATE_MAX_INPUT_BYTES:
            for format_name in ("ips", "ebp"):
                if format_name in large_limit_validation_formats and format_name in selected_patch_formats:
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
        "chd": args.chd_fixture,
        "rvz": args.rvz_fixture,
    }

    if needs_archive_sources:
        for format_name in selected_container_formats:
            codec_cases = rom_weaver_codec_cases_for_format(format_name)
            for codec_label, codec_value in codec_cases:
                print(f"[bench] prep archive source {format_name} codec:{codec_label}", flush=True)
                fixture = static_extract_fixtures.get(format_name)
                if fixture is not None:
                    fixture_resolved = fixture.expanduser().resolve()
                    if fixture_resolved.exists():
                        source = ArchiveSource(
                            format=format_name,
                            path=fixture_resolved,
                            payload_bytes=fixture_resolved.stat().st_size,
                            source_kind="fixture",
                        )
                        archive_sources[(format_name, codec_label)] = source
                        archive_sources_default.setdefault(format_name, source)
                        print(
                            f"[bench] prep ready {format_name} codec:{codec_label} (fixture)",
                            flush=True,
                        )
                        continue
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

                if fixture is not None and fixture.exists():
                    source = ArchiveSource(
                        format=format_name,
                        path=fixture,
                        payload_bytes=fixture.stat().st_size,
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
        use_browser_wasm_json_runner = browser_wasm_persistent_enabled
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
                                cache=cache,
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
                            use_browser_json_runner_value: bool = use_browser_wasm_json_runner,
                        ):
                            run_kind = "warmup" if warmup else "run"
                            host_output_path = (
                                outputs_dir
                                / "compress-wasm"
                                / f"{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}.{suffix_value}"
                            )
                            output_arg_path: Path
                            if use_browser_json_runner_value:
                                # Browser runner writes directly inside OPFS guest paths.
                                output_arg_path = Path(
                                    f"/work/bench-command-paths/outputs/compress-wasm/{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}.{suffix_value}"
                                )
                            else:
                                host_output_path.parent.mkdir(parents=True, exist_ok=True)
                                if host_output_path.exists():
                                    host_output_path.unlink()
                                output_arg_path = host_output_path
                            cmd = wasm_rom_weaver_command(
                                node_bin=node_bin_value,
                                wasm_runner=wasm_runner_value,
                                wasm_module=wasm_module_value,
                                args=rom_weaver_compress_args(
                                    input_path=input_value,
                                    format_name=format_value,
                                    output_path=output_arg_path,
                                    threads=args.threads,
                                    codec_override=codec_value_override,
                                ),
                            )
                            return cmd, host_output_path

                        def make_wasm_args(
                            iteration: int,
                            warmup: bool,
                            format_value: str = format_name,
                            suffix_value: str = suffix,
                            input_value: Path = input_path,
                            codec_label_value: str = codec_label,
                            codec_value_override: str | None = codec_value,
                        ):
                            run_kind = "warmup" if warmup else "run"
                            output_arg_path = Path(
                                f"/work/bench-command-paths/outputs/compress-wasm/{token(format_value)}-{token(codec_label_value)}-{run_kind}-{iteration}.{suffix_value}"
                            )
                            command_args = rom_weaver_compress_args(
                                input_path=input_value,
                                format_name=format_value,
                                output_path=output_arg_path,
                                threads=args.threads,
                                codec_override=codec_value_override,
                            )
                            return command_args, output_arg_path

                        def processed_bytes(_context: Path, input_value: Path = input_path) -> int:
                            return input_value.stat().st_size

                        if use_browser_wasm_json_runner:
                            rows.append(
                                run_benchmark_case_browser_runner(
                                    command="compress",
                                    path_id=format_codec_path_id(format_name, codec_label),
                                    warmups=args.warmups,
                                    iterations=args.iterations,
                                    timeout_sec=args.timeout_sec,
                                    args_factory=make_wasm_args,
                                    processed_bytes_factory=processed_bytes,
                                    runner=browser_runner_for_wasm_module(wasm_module),
                                    tool="rom-weaver-wasm",
                                    cache=cache,
                                )
                            )
                        else:
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
                                    cache=cache,
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
                        cache=cache,
                    )
                )

            if "chdman" in selected_archive_tools:
                assert chdman_bin is not None
                if format_name not in CHDMAN_COMPRESS_FORMATS:
                    rows.append(
                        skipped_row(
                            "compress",
                            f"format:{format_name}",
                            "chdman comparator unsupported for this compress format",
                            args.warmups,
                            args.iterations,
                            tool="chdman",
                        )
                    )
                else:

                    def make_chdman_compress_command(
                        iteration: int,
                        warmup: bool,
                        format_value: str = format_name,
                        suffix_value: str = suffix,
                        input_value: Path = input_path,
                        chdman_value: Path = chdman_bin,
                    ):
                        run_kind = "warmup" if warmup else "run"
                        output_path = (
                            outputs_dir
                            / "compress-chdman"
                            / f"{token(format_value)}-{run_kind}-{iteration}.{suffix_value}"
                        )
                        output_path.parent.mkdir(parents=True, exist_ok=True)
                        if output_path.exists():
                            output_path.unlink()
                        cmd = chdman_compress_command(
                            chdman_bin=chdman_value,
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
                            command_factory=make_chdman_compress_command,
                            processed_bytes_factory=processed_bytes,
                            tool="chdman",
                            cache=cache,
                        )
                    )

            if "dolphin-tool" in selected_archive_tools:
                assert dolphin_tool_bin is not None
                if format_name not in DOLPHIN_TOOL_COMPRESS_FORMATS:
                    rows.append(
                        skipped_row(
                            "compress",
                            f"format:{format_name}",
                            "dolphin-tool comparator unsupported for this compress format",
                            args.warmups,
                            args.iterations,
                            tool="dolphin-tool",
                        )
                    )
                else:

                    def make_dolphin_tool_compress_command(
                        iteration: int,
                        warmup: bool,
                        format_value: str = format_name,
                        suffix_value: str = suffix,
                        input_value: Path = input_path,
                        dolphin_tool_value: Path = dolphin_tool_bin,
                    ):
                        run_kind = "warmup" if warmup else "run"
                        output_path = (
                            outputs_dir
                            / "compress-dolphin-tool"
                            / f"{token(format_value)}-{run_kind}-{iteration}.{suffix_value}"
                        )
                        output_path.parent.mkdir(parents=True, exist_ok=True)
                        if output_path.exists():
                            output_path.unlink()
                        user_dir = (
                            outputs_dir
                            / "dolphin-tool-user"
                            / f"compress-{token(format_value)}-{run_kind}-{iteration}"
                        )
                        if user_dir.exists():
                            shutil.rmtree(user_dir, ignore_errors=True)
                        user_dir.mkdir(parents=True, exist_ok=True)
                        cmd = dolphin_tool_rvz_compress_command(
                            dolphin_tool_bin=dolphin_tool_value,
                            format_name=format_value,
                            input_path=input_value,
                            output_path=output_path,
                            user_dir=user_dir,
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
                            command_factory=make_dolphin_tool_compress_command,
                            processed_bytes_factory=processed_bytes,
                            tool="dolphin-tool",
                            cache=cache,
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
                                "--input",
                                str(source_value.path),
                                "--output",
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
                            cache=cache,
                        )
                        )

            if "rom-weaver-wasm" in selected_archive_tools:
                assert node_bin is not None
                assert wasm_runner is not None
                assert wasm_module is not None
                wasm_module_for_case = wasm_module
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
                        wasm_module_value: Path = wasm_module_for_case,
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
                            cache=cache,
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
                        cache=cache,
                    )
                )

            if "chdman" in selected_archive_tools:
                assert chdman_bin is not None
                source = archive_sources_default.get(format_name)
                if source is None:
                    rows.append(
                        skipped_row(
                            "extract",
                            f"format:{format_name}",
                            "no valid source artifact available for this format",
                            args.warmups,
                            args.iterations,
                            tool="chdman",
                        )
                    )
                elif format_name not in CHDMAN_EXTRACT_FORMATS:
                    rows.append(
                        skipped_row(
                            "extract",
                            f"format:{format_name}",
                            "chdman comparator unsupported for this extract format",
                            args.warmups,
                            args.iterations,
                            tool="chdman",
                        )
                    )
                else:

                    def make_chdman_extract_command(
                        iteration: int,
                        warmup: bool,
                        format_value: str = format_name,
                        source_value: ArchiveSource = source,
                        chdman_value: Path = chdman_bin,
                    ):
                        run_kind = "warmup" if warmup else "run"
                        output_path = (
                            outputs_dir
                            / "extract-chdman"
                            / f"{token(format_value)}-{run_kind}-{iteration}.bin"
                        )
                        output_path.parent.mkdir(parents=True, exist_ok=True)
                        if output_path.exists():
                            output_path.unlink()
                        cmd = chdman_extract_command(
                            chdman_bin=chdman_value,
                            format_name=format_value,
                            source_path=source_value.path,
                            output_path=output_path,
                        )
                        return cmd, output_path

                    def processed_bytes(
                        output_path: Path,
                        source_value: ArchiveSource = source,
                    ) -> int | None:
                        if output_path.exists():
                            return output_path.stat().st_size
                        return source_value.payload_bytes

                    rows.append(
                        run_benchmark_case(
                            command="extract",
                            path_id=f"format:{format_name}",
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_chdman_extract_command,
                            processed_bytes_factory=processed_bytes,
                            tool="chdman",
                            cache=cache,
                        )
                    )

            if "dolphin-tool" in selected_archive_tools:
                assert dolphin_tool_bin is not None
                source = archive_sources_default.get(format_name)
                if source is None:
                    rows.append(
                        skipped_row(
                            "extract",
                            f"format:{format_name}",
                            "no valid source artifact available for this format",
                            args.warmups,
                            args.iterations,
                            tool="dolphin-tool",
                        )
                    )
                elif format_name not in DOLPHIN_TOOL_EXTRACT_FORMATS:
                    rows.append(
                        skipped_row(
                            "extract",
                            f"format:{format_name}",
                            "dolphin-tool comparator unsupported for this extract format",
                            args.warmups,
                            args.iterations,
                            tool="dolphin-tool",
                        )
                    )
                else:

                    def make_dolphin_tool_extract_command(
                        iteration: int,
                        warmup: bool,
                        format_value: str = format_name,
                        source_value: ArchiveSource = source,
                        dolphin_tool_value: Path = dolphin_tool_bin,
                    ):
                        run_kind = "warmup" if warmup else "run"
                        output_path = (
                            outputs_dir
                            / "extract-dolphin-tool"
                            / f"{token(format_value)}-{run_kind}-{iteration}.iso"
                        )
                        output_path.parent.mkdir(parents=True, exist_ok=True)
                        if output_path.exists():
                            output_path.unlink()
                        user_dir = (
                            outputs_dir
                            / "dolphin-tool-user"
                            / f"extract-{token(format_value)}-{run_kind}-{iteration}"
                        )
                        if user_dir.exists():
                            shutil.rmtree(user_dir, ignore_errors=True)
                        user_dir.mkdir(parents=True, exist_ok=True)
                        cmd = dolphin_tool_rvz_extract_command(
                            dolphin_tool_bin=dolphin_tool_value,
                            format_name=format_value,
                            source_path=source_value.path,
                            output_path=output_path,
                            user_dir=user_dir,
                        )
                        return cmd, output_path

                    def processed_bytes(
                        output_path: Path,
                        source_value: ArchiveSource = source,
                    ) -> int | None:
                        if output_path.exists():
                            return output_path.stat().st_size
                        return source_value.payload_bytes

                    rows.append(
                        run_benchmark_case(
                            command="extract",
                            path_id=f"format:{format_name}",
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_dolphin_tool_extract_command,
                            processed_bytes_factory=processed_bytes,
                            tool="dolphin-tool",
                            cache=cache,
                        )
                    )

    if "checksum" in selected_commands:
        if "raw" in selected_checksum_modes:
            ensure_source_fixture()
            for algorithm in selected_checksum_algorithms:
                if needs_rom_weaver:

                    def make_command(_iteration: int, _warmup: bool, algo: str = algorithm):
                        cmd = base_command(
                            args.bin,
                            [
                                "checksum",
                                "--input",
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
                            path_id=f"raw:algo:{algorithm}",
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_command,
                            processed_bytes_factory=processed_bytes,
                            tool="rom-weaver",
                            cache=cache,
                        )
                    )

                if "rom-weaver-wasm" in selected_archive_tools:
                    assert node_bin is not None
                    assert wasm_runner is not None
                    assert wasm_module is not None

                    def make_wasm_command(
                        _iteration: int,
                        _warmup: bool,
                        algo: str = algorithm,
                        node_bin_value: Path = node_bin,
                        wasm_runner_value: Path = wasm_runner,
                        wasm_module_value: Path = wasm_module,
                    ):
                        checksum_args = [
                            "checksum",
                            str(source_path),
                            "--algo",
                            algo,
                            "--no-extract",
                            "--threads",
                            str(args.threads),
                        ]
                        cmd = wasm_rom_weaver_command(
                            node_bin=node_bin_value,
                            wasm_runner=wasm_runner_value,
                            wasm_module=wasm_module_value,
                            args=["--no-progress", *checksum_args],
                        )
                        return cmd, source_path

                    def processed_bytes(_context: Path) -> int:
                        return source_path.stat().st_size

                    rows.append(
                        run_benchmark_case(
                            command="checksum",
                            path_id=f"raw:algo:{algorithm}",
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_wasm_command,
                            processed_bytes_factory=processed_bytes,
                            tool="rom-weaver-wasm",
                            cache=cache,
                        )
                    )

            if checksum_combo_algorithms:
                combo_suffix = checksum_multi_algo_suffix(checksum_combo_algorithms)
                combo_algo_args = checksum_multi_algo_args(checksum_combo_algorithms)
                if needs_rom_weaver:

                    def make_combo_command(
                        _iteration: int,
                        _warmup: bool,
                        algo_args: list[str] = combo_algo_args,
                    ):
                        cmd = base_command(
                            args.bin,
                            [
                                "checksum",
                                "--input",
                                str(source_path),
                                *algo_args,
                                "--no-extract",
                                "--threads",
                                str(args.threads),
                            ],
                        )
                        return cmd, source_path

                    def processed_combo_bytes(_context: Path) -> int:
                        return source_path.stat().st_size

                    rows.append(
                        run_benchmark_case(
                            command="checksum",
                            path_id=f"raw:combo:{combo_suffix}",
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_combo_command,
                            processed_bytes_factory=processed_combo_bytes,
                            tool="rom-weaver",
                            cache=cache,
                        )
                    )

                if "rom-weaver-wasm" in selected_archive_tools:
                    assert node_bin is not None
                    assert wasm_runner is not None
                    assert wasm_module is not None

                    def make_wasm_combo_command(
                        _iteration: int,
                        _warmup: bool,
                        algo_args: list[str] = combo_algo_args,
                        node_bin_value: Path = node_bin,
                        wasm_runner_value: Path = wasm_runner,
                        wasm_module_value: Path = wasm_module,
                    ):
                        checksum_args = [
                            "checksum",
                            str(source_path),
                            *algo_args,
                            "--no-extract",
                            "--threads",
                            str(args.threads),
                        ]
                        cmd = wasm_rom_weaver_command(
                            node_bin=node_bin_value,
                            wasm_runner=wasm_runner_value,
                            wasm_module=wasm_module_value,
                            args=["--no-progress", *checksum_args],
                        )
                        return cmd, source_path

                    def processed_combo_bytes(_context: Path) -> int:
                        return source_path.stat().st_size

                    rows.append(
                        run_benchmark_case(
                            command="checksum",
                            path_id=f"raw:combo:{combo_suffix}",
                            warmups=args.warmups,
                            iterations=args.iterations,
                            timeout_sec=args.timeout_sec,
                            command_factory=make_wasm_combo_command,
                            processed_bytes_factory=processed_combo_bytes,
                            tool="rom-weaver-wasm",
                            cache=cache,
                        )
                    )

        if "auto-extract" in selected_checksum_modes:
            for format_name in selected_container_formats:
                source = archive_sources_default.get(format_name)
                if source is None:
                    if needs_rom_weaver:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"auto-extract:{format_name}",
                                "no valid archive artifact available for auto-extract checksum path",
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver",
                            )
                        )
                    if "rom-weaver-wasm" in selected_archive_tools:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"auto-extract:{format_name}",
                                "no valid archive artifact available for auto-extract checksum path",
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver-wasm",
                            )
                        )
                    if "chdman" in selected_archive_tools:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"auto-extract:{format_name}",
                                "no valid archive artifact available for auto-extract checksum path",
                                args.warmups,
                                args.iterations,
                                tool="chdman",
                            )
                        )
                    if "dolphin-tool" in selected_archive_tools:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"auto-extract:{format_name}",
                                "no valid archive artifact available for auto-extract checksum path",
                                args.warmups,
                                args.iterations,
                                tool="dolphin-tool",
                            )
                        )
                    continue

                if needs_rom_weaver:
                    for algorithm in selected_checksum_algorithms:

                        def make_command(
                            _iteration: int,
                            _warmup: bool,
                            source_value: ArchiveSource = source,
                            algo: str = algorithm,
                        ):
                            cmd = base_command(
                                args.bin,
                                [
                                    "checksum",
                                    "--input",
                                    str(source_value.path),
                                    "--algo",
                                    algo,
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
                                path_id=f"auto-extract:{format_name},algo:{algorithm}",
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_command,
                                processed_bytes_factory=processed_bytes,
                                tool="rom-weaver",
                                cache=cache,
                            )
                        )

                if "rom-weaver-wasm" in selected_archive_tools:
                    assert node_bin is not None
                    assert wasm_runner is not None
                    assert wasm_module is not None
                    wasm_module_for_case = wasm_module
                    for algorithm in selected_checksum_algorithms:

                        def make_wasm_command(
                            _iteration: int,
                            _warmup: bool,
                            source_value: ArchiveSource = source,
                            algo: str = algorithm,
                            node_bin_value: Path = node_bin,
                            wasm_runner_value: Path = wasm_runner,
                            wasm_module_value: Path = wasm_module_for_case,
                        ):
                            checksum_args = [
                                "checksum",
                                str(source_value.path),
                                "--algo",
                                algo,
                                "--threads",
                                str(args.threads),
                            ]
                            cmd = wasm_rom_weaver_command(
                                node_bin=node_bin_value,
                                wasm_runner=wasm_runner_value,
                                wasm_module=wasm_module_value,
                                args=["--no-progress", *checksum_args],
                            )
                            return cmd, source_value

                        def processed_bytes(source_value: ArchiveSource) -> int | None:
                            return source_value.payload_bytes

                        rows.append(
                            run_benchmark_case(
                                command="checksum",
                                path_id=f"auto-extract:{format_name},algo:{algorithm}",
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_wasm_command,
                                processed_bytes_factory=processed_bytes,
                                tool="rom-weaver-wasm",
                                cache=cache,
                            )
                        )

                if "chdman" in selected_archive_tools:
                    assert chdman_bin is not None
                    if format_name not in CHDMAN_CHECKSUM_AUTO_EXTRACT_FORMATS:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"auto-extract:{format_name}",
                                "chdman comparator unsupported for this checksum auto-extract format",
                                args.warmups,
                                args.iterations,
                                tool="chdman",
                            )
                        )
                    else:

                        def make_chdman_checksum_command(
                            _iteration: int,
                            _warmup: bool,
                            format_value: str = format_name,
                            source_value: ArchiveSource = source,
                            chdman_value: Path = chdman_bin,
                        ):
                            cmd = chdman_verify_command(
                                chdman_bin=chdman_value,
                                format_name=format_value,
                                source_path=source_value.path,
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
                                command_factory=make_chdman_checksum_command,
                                processed_bytes_factory=processed_bytes,
                                tool="chdman",
                                cache=cache,
                            )
                        )

                if "dolphin-tool" in selected_archive_tools:
                    assert dolphin_tool_bin is not None
                    if format_name not in DOLPHIN_TOOL_CHECKSUM_AUTO_EXTRACT_FORMATS:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"auto-extract:{format_name}",
                                "dolphin-tool comparator unsupported for this checksum auto-extract format",
                                args.warmups,
                                args.iterations,
                                tool="dolphin-tool",
                            )
                        )
                    else:

                        def make_dolphin_tool_checksum_command(
                            iteration: int,
                            warmup: bool,
                            format_value: str = format_name,
                            source_value: ArchiveSource = source,
                            dolphin_tool_value: Path = dolphin_tool_bin,
                        ):
                            run_kind = "warmup" if warmup else "run"
                            user_dir = (
                                outputs_dir
                                / "dolphin-tool-user"
                                / f"checksum-{token(format_value)}-{run_kind}-{iteration}"
                            )
                            if user_dir.exists():
                                shutil.rmtree(user_dir, ignore_errors=True)
                            user_dir.mkdir(parents=True, exist_ok=True)
                            cmd = dolphin_tool_verify_command(
                                dolphin_tool_bin=dolphin_tool_value,
                                format_name=format_value,
                                source_path=source_value.path,
                                user_dir=user_dir,
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
                                command_factory=make_dolphin_tool_checksum_command,
                                processed_bytes_factory=processed_bytes,
                                tool="dolphin-tool",
                                cache=cache,
                            )
                        )

        if "archive-no-extract" in selected_checksum_modes:
            for format_name in selected_container_formats:
                source = archive_sources_default.get(format_name)
                if source is None:
                    if needs_rom_weaver:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"no-extract:{format_name}",
                                "no valid archive artifact available for checksum no-extract path",
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver",
                            )
                        )
                    if "rom-weaver-wasm" in selected_archive_tools:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"no-extract:{format_name}",
                                "no valid archive artifact available for checksum no-extract path",
                                args.warmups,
                                args.iterations,
                                tool="rom-weaver-wasm",
                            )
                        )
                    if "chdman" in selected_archive_tools:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"no-extract:{format_name}",
                                "no valid archive artifact available for checksum no-extract path",
                                args.warmups,
                                args.iterations,
                                tool="chdman",
                            )
                        )
                    if "dolphin-tool" in selected_archive_tools:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"no-extract:{format_name}",
                                "no valid archive artifact available for checksum no-extract path",
                                args.warmups,
                                args.iterations,
                                tool="dolphin-tool",
                            )
                        )
                    continue

                if needs_rom_weaver:
                    for algorithm in selected_checksum_algorithms:

                        def make_command(
                            _iteration: int,
                            _warmup: bool,
                            source_value: ArchiveSource = source,
                            algo: str = algorithm,
                        ):
                            cmd = base_command(
                                args.bin,
                                [
                                    "checksum",
                                    "--input",
                                    str(source_value.path),
                                    "--algo",
                                    algo,
                                    "--no-extract",
                                    "--threads",
                                    str(args.threads),
                                ],
                            )
                            return cmd, source_value.path

                        def processed_bytes(source_path_value: Path) -> int:
                            return source_path_value.stat().st_size

                        rows.append(
                            run_benchmark_case(
                                command="checksum",
                                path_id=f"no-extract:{format_name},algo:{algorithm}",
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_command,
                                processed_bytes_factory=processed_bytes,
                                tool="rom-weaver",
                                cache=cache,
                            )
                        )

                if "rom-weaver-wasm" in selected_archive_tools:
                    assert node_bin is not None
                    assert wasm_runner is not None
                    assert wasm_module is not None
                    wasm_module_for_case = wasm_module
                    for algorithm in selected_checksum_algorithms:

                        def make_wasm_command(
                            _iteration: int,
                            _warmup: bool,
                            source_value: ArchiveSource = source,
                            algo: str = algorithm,
                            node_bin_value: Path = node_bin,
                            wasm_runner_value: Path = wasm_runner,
                            wasm_module_value: Path = wasm_module_for_case,
                        ):
                            checksum_args = [
                                "checksum",
                                str(source_value.path),
                                "--algo",
                                algo,
                                "--no-extract",
                                "--threads",
                                str(args.threads),
                            ]
                            cmd = wasm_rom_weaver_command(
                                node_bin=node_bin_value,
                                wasm_runner=wasm_runner_value,
                                wasm_module=wasm_module_value,
                                args=["--no-progress", *checksum_args],
                            )
                            return cmd, source_value.path

                        def processed_bytes(source_path_value: Path) -> int:
                            return source_path_value.stat().st_size

                        rows.append(
                            run_benchmark_case(
                                command="checksum",
                                path_id=f"no-extract:{format_name},algo:{algorithm}",
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_wasm_command,
                                processed_bytes_factory=processed_bytes,
                                tool="rom-weaver-wasm",
                                cache=cache,
                            )
                        )

                if "chdman" in selected_archive_tools:
                    assert chdman_bin is not None
                    if format_name not in CHDMAN_CHECKSUM_AUTO_EXTRACT_FORMATS:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"no-extract:{format_name}",
                                "chdman comparator unsupported for this checksum no-extract format",
                                args.warmups,
                                args.iterations,
                                tool="chdman",
                            )
                        )
                    else:

                        def make_chdman_checksum_command(
                            _iteration: int,
                            _warmup: bool,
                            format_value: str = format_name,
                            source_value: ArchiveSource = source,
                            chdman_value: Path = chdman_bin,
                        ):
                            cmd = chdman_verify_command(
                                chdman_bin=chdman_value,
                                format_name=format_value,
                                source_path=source_value.path,
                            )
                            return cmd, source_value.path

                        def processed_bytes(source_path_value: Path) -> int:
                            return source_path_value.stat().st_size

                        rows.append(
                            run_benchmark_case(
                                command="checksum",
                                path_id=f"no-extract:{format_name}",
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_chdman_checksum_command,
                                processed_bytes_factory=processed_bytes,
                                tool="chdman",
                                cache=cache,
                            )
                        )

                if "dolphin-tool" in selected_archive_tools:
                    assert dolphin_tool_bin is not None
                    if format_name not in DOLPHIN_TOOL_CHECKSUM_AUTO_EXTRACT_FORMATS:
                        rows.append(
                            skipped_row(
                                "checksum",
                                f"no-extract:{format_name}",
                                "dolphin-tool comparator unsupported for this checksum no-extract format",
                                args.warmups,
                                args.iterations,
                                tool="dolphin-tool",
                            )
                        )
                    else:

                        def make_dolphin_tool_checksum_command(
                            iteration: int,
                            warmup: bool,
                            format_value: str = format_name,
                            source_value: ArchiveSource = source,
                            dolphin_tool_value: Path = dolphin_tool_bin,
                        ):
                            run_kind = "warmup" if warmup else "run"
                            user_dir = (
                                outputs_dir
                                / "dolphin-tool-user"
                                / f"checksum-no-extract-{token(format_value)}-{run_kind}-{iteration}"
                            )
                            if user_dir.exists():
                                shutil.rmtree(user_dir, ignore_errors=True)
                            user_dir.mkdir(parents=True, exist_ok=True)
                            cmd = dolphin_tool_verify_command(
                                dolphin_tool_bin=dolphin_tool_value,
                                format_name=format_value,
                                source_path=source_value.path,
                                user_dir=user_dir,
                            )
                            return cmd, source_value.path

                        def processed_bytes(source_path_value: Path) -> int:
                            return source_path_value.stat().st_size

                        rows.append(
                            run_benchmark_case(
                                command="checksum",
                                path_id=f"no-extract:{format_name}",
                                warmups=args.warmups,
                                iterations=args.iterations,
                                timeout_sec=args.timeout_sec,
                                command_factory=make_dolphin_tool_checksum_command,
                                processed_bytes_factory=processed_bytes,
                                tool="dolphin-tool",
                                cache=cache,
                            )
                        )

    patch_tools: list[str] = ["rom-weaver"]
    if "rom-weaver-wasm" in selected_archive_tools:
        patch_tools.append("rom-weaver-wasm")
    created_patch_sources: dict[tuple[str, str], tuple[Path, Path]] = {}

    def patch_artifact_path(format_name: str, patch_tool: str, extension: str) -> Path:
        return artifacts_dir / "patches" / f"{token(format_name)}-{token(patch_tool)}.{extension}"

    def patch_fixture_paths_for_format(format_name: str) -> tuple[Path, Path]:
        if format_name == "dldi":
            ensure_dldi_fixtures()
            return dldi_original_path, dldi_modified_path
        if format_name in {"ips", "ebp"}:
            ensure_ips_ebp_fixtures()
            return ips_ebp_original_path, ips_ebp_modified_path
        ensure_patch_pair_fixtures()
        return original_path, modified_path

    def materialize_patch_source(format_name: str, patch_tool: str) -> tuple[Path, Path] | None:
        if format_name in EXPECTED_PATCH_CREATE_SKIPS:
            return None
        extension = PATCH_EXTENSION[format_name]
        patch_path = patch_artifact_path(format_name, patch_tool, extension)
        patch_original, patch_modified = patch_fixture_paths_for_format(format_name)
        if patch_path.exists():
            return patch_path, patch_original
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        patch_args = [
            "patch",
            "create",
            "--original",
            str(patch_original),
            "--modified",
            str(patch_modified),
            "--format",
            format_name,
            "--output",
            str(patch_path),
            "--threads",
            str(args.threads),
        ]
        if patch_tool == "rom-weaver":
            prep_cmd = base_command(args.bin, patch_args)
        else:
            assert node_bin is not None
            assert wasm_runner is not None
            assert wasm_module is not None
            prep_cmd = wasm_rom_weaver_command(
                node_bin=node_bin,
                wasm_runner=wasm_runner,
                wasm_module=wasm_module,
                args=["--no-progress", *patch_args],
            )
        prep = run_timed_command(prep_cmd, Path.cwd(), args.timeout_sec)
        if prep.exit_code == 0 and patch_path.exists():
            print(f"[bench] materialized patch artifact {patch_tool} {format_name}", flush=True)
            return patch_path, patch_original
        tail = outcome_tail_message(prep) or "patch artifact was not produced"
        print(f"[bench] failed to materialize patch artifact {patch_tool} {format_name}: {tail}", flush=True)
        return None

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
            patch_original, patch_modified = patch_fixture_paths_for_format(format_name)

            for patch_tool in patch_tools:
                if patch_tool == "rom-weaver-wasm":
                    assert node_bin is not None
                    assert wasm_runner is not None
                    assert wasm_module is not None

                def make_command(
                    _iteration: int,
                    _warmup: bool,
                    format_value: str = format_name,
                    extension_value: str = extension,
                    original_value: Path = patch_original,
                    modified_value: Path = patch_modified,
                    tool_value: str = patch_tool,
                    node_bin_value: Path | None = node_bin,
                    wasm_runner_value: Path | None = wasm_runner,
                    wasm_module_value: Path | None = wasm_module,
                ):
                    patch_path = patch_artifact_path(format_value, tool_value, extension_value)
                    patch_path.parent.mkdir(parents=True, exist_ok=True)
                    if patch_path.exists():
                        patch_path.unlink()
                    patch_args = [
                        "patch",
                        "create",
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
                    ]
                    if tool_value == "rom-weaver":
                        cmd = base_command(args.bin, patch_args)
                    else:
                        assert node_bin_value is not None
                        assert wasm_runner_value is not None
                        assert wasm_module_value is not None
                        cmd = wasm_rom_weaver_command(
                            node_bin=node_bin_value,
                            wasm_runner=wasm_runner_value,
                            wasm_module=wasm_module_value,
                            args=["--no-progress", *patch_args],
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
                    tool=patch_tool,
                    cache=cache,
                )
                rows.append(row)

                if row.status == "succeeded":
                    patch_path = patch_artifact_path(format_name, patch_tool, extension)
                    if "patch-apply" in selected_commands and not patch_path.exists():
                        patch_path.parent.mkdir(parents=True, exist_ok=True)
                        patch_args = [
                            "patch",
                            "create",
                            "--original",
                            str(patch_original),
                            "--modified",
                            str(patch_modified),
                            "--format",
                            format_name,
                            "--output",
                            str(patch_path),
                            "--threads",
                            str(args.threads),
                        ]
                        if patch_tool == "rom-weaver":
                            prep_cmd = base_command(args.bin, patch_args)
                        else:
                            assert node_bin is not None
                            assert wasm_runner is not None
                            assert wasm_module is not None
                            prep_cmd = wasm_rom_weaver_command(
                                node_bin=node_bin,
                                wasm_runner=wasm_runner,
                                wasm_module=wasm_module,
                                args=["--no-progress", *patch_args],
                            )
                        prep = run_timed_command(prep_cmd, Path.cwd(), args.timeout_sec)
                        if prep.exit_code == 0 and patch_path.exists():
                            print(
                                f"[bench] materialized cached patch artifact {patch_tool} {format_name}",
                                flush=True,
                            )
                        else:
                            tail = outcome_tail_message(prep) or "patch artifact was not produced"
                            print(
                                f"[bench] failed to materialize cached patch artifact {patch_tool} {format_name}: {tail}",
                                flush=True,
                            )
                    if patch_path.exists():
                        created_patch_sources[(patch_tool, format_name)] = (patch_path, patch_original)

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
            for patch_tool in patch_tools:
                if patch_tool == "rom-weaver-wasm":
                    assert node_bin is not None
                    assert wasm_runner is not None
                    assert wasm_module is not None

                created_patch = created_patch_sources.get((patch_tool, format_name))
                if created_patch is None and format_name not in EXPECTED_PATCH_CREATE_SKIPS:
                    created_patch = materialize_patch_source(format_name, patch_tool)
                    if created_patch is not None:
                        created_patch_sources[(patch_tool, format_name)] = created_patch
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
                                tool=patch_tool,
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
                    tool_value: str = patch_tool,
                    node_bin_value: Path | None = node_bin,
                    wasm_runner_value: Path | None = wasm_runner,
                    wasm_module_value: Path | None = wasm_module,
                ):
                    run_kind = "warmup" if warmup else "run"
                    out_dir_name = "patch-apply" if tool_value == "rom-weaver" else "patch-apply-wasm"
                    output_path = (
                        outputs_dir
                        / out_dir_name
                        / f"{token(format_value)}-{token(tool_value)}-{run_kind}-{iteration}.bin"
                    )
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    if output_path.exists():
                        output_path.unlink()
                    patch_apply_args = [
                        "patch",
                        "apply",
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
                    ]
                    if tool_value == "rom-weaver":
                        cmd = base_command(args.bin, patch_apply_args)
                    else:
                        assert node_bin_value is not None
                        assert wasm_runner_value is not None
                        assert wasm_module_value is not None
                        cmd = wasm_rom_weaver_command(
                            node_bin=node_bin_value,
                            wasm_runner=wasm_runner_value,
                            wasm_module=wasm_module_value,
                            args=["--no-progress", *patch_apply_args],
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
                    tool=patch_tool,
                    cache=cache,
                )
                rows.append(row)

    for runner in browser_wasm_json_runners.values():
        runner.close()

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
            "fixture_cache_dir": str(fixture_cache_dir),
            "archive_tools": selected_archive_tools,
            "sevenzip_bin": str(sevenzip_bin) if sevenzip_bin is not None else None,
            "chdman_bin": str(chdman_bin) if chdman_bin is not None else None,
            "dolphin_tool_bin": str(dolphin_tool_bin) if dolphin_tool_bin is not None else None,
            "node_bin": str(node_bin) if node_bin is not None else None,
            "wasm_runner": str(wasm_runner) if wasm_runner is not None else None,
            "wasm_module": str(wasm_module) if wasm_module is not None else None,
            "browser_wasm_persistent_session": args.browser_wasm_persistent_session,
            "commands": sorted(selected_commands),
            "container_formats": selected_container_formats,
            "container_codecs": sorted(CONTAINER_CODEC_LABEL_FILTER) if CONTAINER_CODEC_LABEL_FILTER is not None else ["all"],
            "patch_formats": selected_patch_formats,
            "checksum_algorithms": selected_checksum_algorithms,
            "checksum_combo_algorithms": checksum_combo_algorithms,
            "checksum_modes": sorted(selected_checksum_modes),
            "rar_fixture": str(args.rar_fixture),
            "chd_fixture": str(args.chd_fixture) if args.chd_fixture is not None else None,
            "rvz_fixture": str(args.rvz_fixture) if args.rvz_fixture is not None else None,
            "source_bin_fixture": str(args.source_bin_fixture) if args.source_bin_fixture is not None else None,
            "source_disc_fixture": str(args.source_disc_fixture) if args.source_disc_fixture is not None else None,
            "threads": args.threads,
            "warmups": args.warmups,
            "iterations": args.iterations,
            "size_mib": args.size_mib,
            "patch_size_mib": args.patch_size_mib,
            "timeout_sec": args.timeout_sec,
            "python": sys.version,
            "platform": platform.platform(),
            "cache": {
                "mode": args.cache_mode,
                "file": str(args.cache_file.expanduser().resolve()),
                "hits": cache.hit_count if cache is not None else 0,
                "writes": cache.write_count if cache is not None else 0,
            },
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

    if cache is not None:
        cache.save()
        print(f"[bench] cache saved hits={cache.hit_count} writes={cache.write_count} file={cache.path}", flush=True)

    print("\nJSON:")
    print(json.dumps(payload))

    if not args.keep_work_dir:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
