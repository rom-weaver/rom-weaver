#!/usr/bin/env python3
"""Compare two rom-weaver binaries command by command and fail on a slowdown.

    python3 scripts/bench-compare.py --base OLD_BIN --candidate NEW_BIN \\
        --fixtures DIR --out DIR [--cases a,b] [--threshold 1.10] [--runs 10] \\
        [--warmup 2] [--slow-candidate SECONDS]

The fixtures directory MUST already hold the NKit images that
`cargo run --release -p rom-weaver-containers --example nkit_fixture -- DIR` writes:
`rom-weaver compress` stores no NKit digests, so no image it makes reaches that
extract path. The script writes the other fixtures itself and builds the archives
and the patch with the base binary, so both binaries read the same inputs.

Each round runs base and candidate once, back to back, and alternates which
goes first, so load that drifts during a case slows both sides alike. Before
every run the command's output is deleted and the page cache is synced, so
writeback of the previous run's output is not billed to the next one. A case
regresses when both the median ratio and the minimum ratio (candidate / base)
exceed the threshold: interference only adds time, so one slow run must neither
hide a regression nor invent one. The exit status is 1 on any regression or
failed case.

--slow-candidate N sleeps N seconds inside each timed candidate run, a self-test
that the gate trips without a real regression.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

MIB = 1024 * 1024

# {bin} = binary, {fx} = fixtures directory, {o} = per-command output directory. Templates are
# split on spaces before the fields are filled, so the paths may contain spaces.
CASES = {
    # NKit images are the shape nodtool and NKit write; rom-weaver-made images skip the digest check.
    "rvz-extract-nkit": "{bin} extract -q --no-progress {fx}/gcjunk-nkit.rvz -o {o}",
    "wia-extract-nkit": "{bin} extract -q --no-progress {fx}/gcjunk-nkit.wia -o {o}",
    "rvz-create": "{bin} compress -q --no-progress {fx}/gc.iso -o {o}/gc.rvz",
    "chd-create": "{bin} compress -q --no-progress {fx}/gc.iso -o {o}/gc.chd",
    "chd-extract": "{bin} extract -q --no-progress {fx}/gc.chd -o {o}",
    "zip-extract": "{bin} extract -q --no-progress {fx}/raw.zip -o {o}",
    "checksum": "{bin} checksum -q --no-progress {fx}/raw.bin",
    "patch-apply-xdelta": (
        "{bin} patch apply -q --no-progress --no-compress --input {fx}/raw.bin"
        " --patch {fx}/raw.xdelta -o {o}/out.bin"
    ),
}


def write_mixed(handle, size: int, seed: int) -> None:
    """Alternate 1 MiB of seeded random bytes with 1 MiB of a compressible ramp."""
    rng = random.Random(seed)
    ramp = bytes(index % 251 for index in range(MIB))
    written = 0
    index = 0
    while written < size:
        chunk = (rng.randbytes(MIB) if index % 2 == 0 else ramp)[: size - written]
        handle.write(chunk)
        written += len(chunk)
        index += 1


def write_gc_iso(path: Path, size: int) -> None:
    header = bytearray(0x440)
    header[:6] = b"RWTEST"
    header[0x1C:0x20] = bytes([0xC2, 0x33, 0x9F, 0x3D])
    title = b"rom-weaver-bench\x00"
    header[0x20 : 0x20 + len(title)] = title
    with path.open("wb") as handle:
        handle.write(header)
        write_mixed(handle, size - len(header), 0x6C)


def write_modified(source: Path, target: Path) -> None:
    """Copy `source` with 128 scattered 4 KiB edits, the input of `patch create`."""
    data = bytearray(source.read_bytes())
    stride = max(4096, len(data) // 128)
    for block in range(128):
        start = 17 + block * stride
        for index in range(start, min(len(data), start + 4096)):
            data[index] = (data[index] + 37 + block % 11) % 256
    target.write_bytes(data)


def write_raw(path: Path) -> None:
    with path.open("wb") as handle:
        write_mixed(handle, 256 * MIB, 0x5EED)


def run_base(base: Path, *args: str) -> None:
    subprocess.run([str(base), *args, "-q", "--no-progress"], check=True, stdout=subprocess.DEVNULL)


def prepare_fixtures(fixtures: Path, base: Path) -> None:
    """Write each missing fixture; existing ones are reused, so a local rerun is fast."""
    for name in ("gcjunk-nkit.rvz", "gcjunk-nkit.wia"):
        if not (fixtures / name).is_file():
            sys.exit(
                f"{fixtures / name} is missing; write it with"
                f" `cargo run --release -p rom-weaver-containers --example nkit_fixture -- {fixtures}`"
            )
    raw, modified = str(fixtures / "raw.bin"), str(fixtures / "mod.bin")
    steps = [
        ("gc.iso", lambda path: write_gc_iso(path, 512 * MIB)),
        ("raw.bin", write_raw),
        ("mod.bin", lambda path: write_modified(fixtures / "raw.bin", path)),
        ("gc.chd", lambda path: run_base(base, "compress", str(fixtures / "gc.iso"), "-o", str(path))),
        ("raw.zip", lambda path: run_base(base, "compress", raw, "-o", str(path))),
        (
            "raw.xdelta",
            lambda path: run_base(base, "patch", "create", "--original", raw, "--modified", modified, "-o", str(path)),
        ),
    ]
    for name, write in steps:
        path = fixtures / name
        if path.is_file():
            continue
        print(f"[bench-compare] writing {name}", file=sys.stderr, flush=True)
        # The partial name keeps the real extension, which picks the output format.
        partial = path.with_name(f"{path.stem}.partial{path.suffix}")
        try:
            write(partial)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        partial.rename(path)


def time_run(command: list[str], out: Path, delay: float) -> float:
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    os.sync()
    start = time.perf_counter()
    if delay:
        time.sleep(delay)
    proc = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(command)} exited {proc.returncode}: {proc.stderr[-2000:]}")
    return elapsed


def run_case(name: str, args, work: Path) -> dict:
    sides = {}
    for label, binary in (("base", args.base), ("candidate", args.candidate)):
        out = work / f"{name}-{label}"
        fields = {"bin": binary, "fx": args.fixtures, "o": out}
        command = [token.format(**fields) for token in CASES[name].split(" ")]
        sides[label] = (command, out, args.slow_candidate if label == "candidate" else 0.0)
    samples = {"base": [], "candidate": []}
    print(f"[bench-compare] {name}", file=sys.stderr, flush=True)
    try:
        for round_index in range(args.warmup + args.runs):
            order = ("base", "candidate") if round_index % 2 == 0 else ("candidate", "base")
            for label in order:
                elapsed = time_run(*sides[label])
                if round_index >= args.warmup:
                    samples[label].append(elapsed)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return {"case": name, "error": str(error).splitlines()[0]}
    finally:
        for _, out, _ in sides.values():
            shutil.rmtree(out, ignore_errors=True)
    commands = {label: " ".join(sides[label][0]) for label in sides}
    (args.out / f"{name}.json").write_text(json.dumps({"commands": commands, "seconds": samples}, indent=2))
    base_median, candidate_median = (statistics.median(samples[label]) for label in ("base", "candidate"))
    median_ratio = candidate_median / base_median
    min_ratio = min(samples["candidate"]) / min(samples["base"])
    return {
        "case": name,
        "base_median": base_median,
        "candidate_median": candidate_median,
        "median_ratio": median_ratio,
        "min_ratio": min_ratio,
        "regressed": median_ratio > args.threshold and min_ratio > args.threshold,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two rom-weaver binaries command by command.")
    parser.add_argument("--base", type=Path, required=True, help="binary to compare against")
    parser.add_argument("--candidate", type=Path, required=True, help="binary under test")
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="per-case timings and summary.json")
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--threshold", type=float, default=1.10)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument(
        "--slow-candidate",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="seconds to add to each candidate run, to test the gate",
    )
    args = parser.parse_args()
    names = args.cases.split(",")
    unknown = [name for name in names if name not in CASES]
    if unknown:
        parser.error(f"unknown cases: {', '.join(unknown)} (known: {', '.join(CASES)})")
    # The negated range also rejects nan and inf, which time.sleep() refuses.
    if args.runs < 1 or args.warmup < 0 or not 0 <= args.slow_candidate < math.inf:
        parser.error("--runs must be at least 1, --warmup at least 0, and --slow-candidate finite and at least 0")
    for binary in (args.base, args.candidate):
        if not os.access(binary, os.X_OK):
            parser.error(f"{binary} is not an executable file")
    args.base, args.candidate = args.base.resolve(), args.candidate.resolve()
    args.fixtures.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    # Neither binary may read or write the runner's real config, cache, or data.
    home = args.out / "home"
    os.environ.update(
        HOME=str(home),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_CACHE_HOME=str(home / ".cache"),
        XDG_DATA_HOME=str(home / ".local/share"),
    )
    for variable in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"):
        Path(os.environ[variable]).mkdir(parents=True, exist_ok=True)
    prepare_fixtures(args.fixtures, args.base)
    work = args.out / "work"
    work.mkdir(exist_ok=True)
    rows = [run_case(name, args, work) for name in names]
    (args.out / "summary.json").write_text(json.dumps(rows, indent=2))
    print("| Case | Base median (s) | Candidate median (s) | Median ratio | Min ratio | Result |")
    print("| --- | --- | --- | --- | --- | --- |")
    failed = False
    for row in rows:
        if "error" in row:
            failed = True
            print(f"| {row['case']} | | | | | ERROR: {row['error']} |")
            continue
        failed |= row["regressed"]
        verdict = f"**REGRESSION** (> {args.threshold:.2f})" if row["regressed"] else "ok"
        print(
            f"| {row['case']} | {row['base_median']:.3f} | {row['candidate_median']:.3f}"
            f" | {row['median_ratio']:.2f} | {row['min_ratio']:.2f} | {verdict} |"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
