#!/usr/bin/env bash
# Re-validate rom-weaver's compression output against the REAL reference tools
# (chdman, dolphin-tool), so a vendored-codec regression (lzma-rust2, flac,
# zstd, nod, ciso) is caught.
#
# The in-repo cli_smoke tests only round-trip rom-weaver against itself and
# diff against frozen vectors; nothing re-checks the live tools. This script
# closes that gap and is the regression signal for the nightly `parity`
# workflow (.github/workflows/parity.yml).
#
# What "parity" means here, and why this is NOT a naive `cmp` of the two
# container files:
#
#   * CHD: rom-weaver's `createhd` output is content-identical to chdman's --
#     the decompressed-hunk Raw SHA1 and the Overall SHA1 stored in the CHD v5
#     header match byte-for-byte -- but the *container byte layout* differs
#     (rom-weaver appends the GDDD hard-disk metadata block after the hunk map;
#     chdman writes it right after the header). So `cmp rw.chd ref.chd` would
#     false-fail. The real codec/payload signal is: chdman fully VERIFIES
#     rom-weaver's CHD (Raw + Overall SHA1) and extracts it back byte-for-byte,
#     and rom-weaver extracts chdman's CHD back byte-for-byte. A broken
#     lzma-rust2 / flac / zstd encoder changes the decompressed hunks, which
#     `chdman verify` and the extract-and-cmp catch.
#
#   * RVZ: dolphin-tool's RVZ encoder scrubs/repacks disc structures, so its
#     RVZ is not byte-identical to rom-weaver's on a synthetic fixture (and a
#     valid licensed disc image cannot be committed). The honest, regression-
#     sensitive check is a cross-tool ROUND TRIP: rom-weaver creates an RVZ
#     that dolphin-tool extracts back to the source ISO byte-for-byte, and
#     dolphin-tool creates an RVZ that rom-weaver extracts back byte-for-byte.
#     A broken nod / zstd encoder corrupts the RVZ and the round trip diverges.
#
# All fixtures are generated deterministically (seeded byte patterns, never
# random) under the repo `target/` dir so reruns are reproducible.
#
# Tool binaries are parameterized via env for CI / non-PATH installs:
#   CHDMAN_BIN       (default: PATH lookup for `chdman`)
#   DOLPHIN_TOOL_BIN (default: PATH lookup for `dolphin-tool`)
#   ROM_WEAVER_BIN   (default: the built CLI under target/{release,debug})
#   PARITY_CARGO_PROFILE (default: debug; set to `release` to build/use release)
#
# Exits non-zero with a clear diff message on ANY mismatch.
#
# Usage (from anywhere in the checkout):  scripts/parity-check.sh
set -euo pipefail

log() { printf '[parity] %s\n' "$*"; }
fail() {
  printf '[parity] FAIL: %s\n' "$*" >&2
  exit 1
}

repo_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

profile="${PARITY_CARGO_PROFILE:-debug}"
case "$profile" in
  debug | release) ;;
  *) fail "PARITY_CARGO_PROFILE must be 'debug' or 'release' (got: $profile)" ;;
esac

# ---------------------------------------------------------------------------
# Resolve tool binaries.
# ---------------------------------------------------------------------------
CHDMAN_BIN="${CHDMAN_BIN:-chdman}"
DOLPHIN_TOOL_BIN="${DOLPHIN_TOOL_BIN:-dolphin-tool}"

require_tool() {
  local label="$1" bin="$2"
  if ! command -v "$bin" >/dev/null 2>&1 && [[ ! -x "$bin" ]]; then
    fail "$label binary not found: '$bin' (set ${label}_BIN or install it; e.g. npm i -g chdman dolphin-tool)"
  fi
}
require_tool CHDMAN "$CHDMAN_BIN"
require_tool DOLPHIN_TOOL "$DOLPHIN_TOOL_BIN"

# ---------------------------------------------------------------------------
# Build (or locate) the rom-weaver CLI.
# ---------------------------------------------------------------------------
rom_weaver_bin="${ROM_WEAVER_BIN:-}"
if [[ -z "$rom_weaver_bin" ]]; then
  rom_weaver_bin="$repo_root/target/$profile/rom-weaver"
  if [[ ! -x "$rom_weaver_bin" ]]; then
    log "building rom-weaver CLI ($profile profile)"
    if [[ "$profile" == "release" ]]; then
      cargo build --manifest-path "$repo_root/Cargo.toml" --release -p rom-weaver-cli
    else
      cargo build --manifest-path "$repo_root/Cargo.toml" -p rom-weaver-cli
    fi
  fi
fi
[[ -x "$rom_weaver_bin" ]] || fail "rom-weaver CLI not found/executable at: $rom_weaver_bin"

log "rom-weaver: $rom_weaver_bin ($("$rom_weaver_bin" --version 2>/dev/null | head -1))"
log "chdman:     $(command -v "$CHDMAN_BIN" || echo "$CHDMAN_BIN")"
log "dolphin:    $(command -v "$DOLPHIN_TOOL_BIN" || echo "$DOLPHIN_TOOL_BIN")"

# ---------------------------------------------------------------------------
# Scratch workspace under target/ (gitignored, reproducible).
# ---------------------------------------------------------------------------
work_root="$repo_root/target/parity-check"
rm -rf "$work_root"
mkdir -p "$work_root"
log "workspace: $work_root"

sha1_of() {
  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum "$1" | awk '{print $1}'
  else
    shasum -a 1 "$1" | awk '{print $1}'
  fi
}

# Deterministic, compressible fixture. Seeded byte pattern (NOT random), sized
# to a clean CHD HD geometry and >1 hunk so the codec path is exercised. The
# pattern is low-entropy enough that LZMA wins every hunk in BOTH tools, which
# is the regime the byte-identical-content invariant covers.
gen_fixture() {
  local path="$1" size="$2"
  python3 - "$path" "$size" <<'PY'
import sys
path = sys.argv[1]
size = int(sys.argv[2])
buf = bytearray(size)
for i in range(size):
    buf[i] = ((i // 64) + (i % 17)) & 0xFF
with open(path, "wb") as f:
    f.write(buf)
PY
}

# rom-weaver extract names its output from the SOURCE basename (foo.chd ->
# foo.img / foo.iso), so callers compare against that derived name.
rw_extract_one() {
  local src="$1" out_dir="$2"
  rm -rf "$out_dir"
  mkdir -p "$out_dir"
  "$rom_weaver_bin" extract "$src" --out-dir "$out_dir" --json >/dev/null
}

failures=0
section() { printf '\n[parity] === %s ===\n' "$*"; }

# ===========================================================================
# CHD parity (lzma-rust2 / flac / zstd / ciso codecs)
# ===========================================================================
section "CHD createhd parity vs chdman"

chd_dir="$work_root/chd"
mkdir -p "$chd_dir"
# 4 MiB -> CHS 16/16/32, 512 B sectors, 8 sectors/hunk: matches chdman createhd
# defaults so the only variable is the codec output itself. `.img` makes
# rom-weaver take the hard-disk path (GDDD metadata + 512 B units), the same
# media class chdman createhd produces.
chd_src="$chd_dir/disc.img"
gen_fixture "$chd_src" $((4 * 1024 * 1024))
chd_src_sha1="$(sha1_of "$chd_src")"
log "fixture disc.img sha1=$chd_src_sha1 ($(wc -c <"$chd_src") bytes)"

# (1) rom-weaver creates the CHD; default codec plan must equal chdman's
#     createhd default (lzma,zlib,huff,flac). No --codec => rom-weaver picks
#     the same plan; matches scripts/bench-command-paths.py (empty
#     compress_codec_by_format for chd).
rw_chd="$chd_dir/rw.chd"
log "rom-weaver compress disc.img -> rw.chd"
"$rom_weaver_bin" compress "$chd_src" --format chd --output "$rw_chd" --threads 1 --json >/dev/null

# (2) chdman must VERIFY rom-weaver's CHD: Raw SHA1 (decompressed hunks) AND
#     Overall SHA1 (hunks + metadata). A vendored-codec regression changes the
#     decompressed hunks and fails this.
log "chdman verify rw.chd"
if ! verify_out="$("$CHDMAN_BIN" verify -i "$rw_chd" 2>&1)"; then
  printf '%s\n' "$verify_out" >&2
  fail "chdman could not parse/verify rom-weaver's CHD"
fi
if ! grep -qi "Raw SHA1 verification successful" <<<"$verify_out"; then
  printf '%s\n' "$verify_out" >&2
  fail "chdman Raw SHA1 verification did NOT succeed on rom-weaver's CHD (codec output regression?)"
fi
if ! grep -qi "Overall SHA1 verification successful" <<<"$verify_out"; then
  printf '%s\n' "$verify_out" >&2
  fail "chdman Overall SHA1 verification did NOT succeed on rom-weaver's CHD"
fi
log "chdman verify: Raw SHA1 + Overall SHA1 OK"

# (3) chdman extracts rom-weaver's CHD; extracted image must equal the source.
chd_rw_extract="$chd_dir/rw-extract.img"
log "chdman extracthd rw.chd -> rw-extract.img"
"$CHDMAN_BIN" extracthd -f -i "$rw_chd" -o "$chd_rw_extract" >/dev/null 2>&1
if cmp -s "$chd_rw_extract" "$chd_src"; then
  log "OK: chdman-extracted rom-weaver CHD is byte-identical to the source"
else
  cmp "$chd_rw_extract" "$chd_src" || true
  log "ERROR: chdman extract of rom-weaver's CHD differs from source (sha1 want=$chd_src_sha1 got=$(sha1_of "$chd_rw_extract"))"
  failures=$((failures + 1))
fi

# (4) Reverse: chdman creates the CHD, rom-weaver extracts it; must equal source.
ref_chd="$chd_dir/ref.chd"
log "chdman createhd disc.img -> ref.chd"
"$CHDMAN_BIN" createhd -f -np 1 -i "$chd_src" -o "$ref_chd" >/dev/null 2>&1
rw_chd_extract_dir="$chd_dir/ref-extract"
log "rom-weaver extract ref.chd"
rw_extract_one "$ref_chd" "$rw_chd_extract_dir"
chd_ref_extract="$rw_chd_extract_dir/ref.img"
if [[ ! -f "$chd_ref_extract" ]]; then
  log "ERROR: rom-weaver did not emit ref.img from chdman's CHD; got: $(find "$rw_chd_extract_dir" -maxdepth 1 -mindepth 1 -printf '%f ' 2>/dev/null)"
  failures=$((failures + 1))
elif cmp -s "$chd_ref_extract" "$chd_src"; then
  log "OK: rom-weaver-extracted chdman CHD is byte-identical to the source"
else
  cmp "$chd_ref_extract" "$chd_src" || true
  log "ERROR: rom-weaver extract of chdman's CHD differs from source (sha1 want=$chd_src_sha1 got=$(sha1_of "$chd_ref_extract"))"
  failures=$((failures + 1))
fi

# (5) Cross-tool Overall SHA1 equivalence: the SHA1 chdman stamps into the CHD
#     header (computed over decompressed hunks + metadata) must be identical
#     for both encoders. This is the single strongest content-parity signal.
rw_overall_sha1="$(xxd -s 84 -l 20 -p "$rw_chd" | tr -d '\n')"
ref_overall_sha1="$(xxd -s 84 -l 20 -p "$ref_chd" | tr -d '\n')"
rw_raw_sha1="$(xxd -s 64 -l 20 -p "$rw_chd" | tr -d '\n')"
ref_raw_sha1="$(xxd -s 64 -l 20 -p "$ref_chd" | tr -d '\n')"
if [[ "$rw_raw_sha1" == "$ref_raw_sha1" && "$rw_overall_sha1" == "$ref_overall_sha1" ]]; then
  log "OK: CHD Raw SHA1 ($rw_raw_sha1) and Overall SHA1 ($rw_overall_sha1) match chdman byte-for-byte"
else
  log "ERROR: CHD header SHA1 mismatch vs chdman:"
  log "  Raw SHA1     rom-weaver=$rw_raw_sha1  chdman=$ref_raw_sha1"
  log "  Overall SHA1 rom-weaver=$rw_overall_sha1  chdman=$ref_overall_sha1"
  failures=$((failures + 1))
fi

# ===========================================================================
# RVZ parity (nod / zstd) -- cross-tool round trip (see header for rationale).
# ===========================================================================
section "RVZ round-trip parity vs dolphin-tool"

rvz_dir="$work_root/rvz"
mkdir -p "$rvz_dir"
dolphin_user="$rvz_dir/dolphin-user"
mkdir -p "$dolphin_user"

# Minimal-but-valid GameCube disc image: the GC magic 0xC2339F3D at 0x1C is
# what dolphin-tool requires to accept the input. Payload is the same seeded,
# deterministic ramp. Mirrors the cli_smoke `build_test_gamecube_iso` fixture.
rvz_src="$rvz_dir/disc.iso"
python3 - "$rvz_src" $((4 * 1024 * 1024)) <<'PY'
import sys
path = sys.argv[1]
payload_len = int(sys.argv[2])
total = 0x440 + payload_len
b = bytearray(total)
b[0:6] = b"RWTEST"
b[0x1C:0x20] = bytes([0xC2, 0x33, 0x9F, 0x3D])
title = b"rom-weaver-test\x00"
b[0x20:0x20 + len(title)] = title
for i in range(0x440, total):
    b[i] = (i - 0x440) % 251
with open(path, "wb") as f:
    f.write(b)
PY
rvz_src_sha1="$(sha1_of "$rvz_src")"
log "fixture disc.iso sha1=$rvz_src_sha1 ($(wc -c <"$rvz_src") bytes)"

# dolphin-tool prints a harmless "No bundle id found" line on macOS; drop it
# and never let it fail the step.
run_dolphin() {
  "$DOLPHIN_TOOL_BIN" "$@" 2>&1 | grep -vi "bundle id" || true
}

# (1) rom-weaver creates an RVZ at dolphin's reference settings (zstd, level 5,
#     128 KiB block).
rw_rvz="$rvz_dir/rw.rvz"
log "rom-weaver compress disc.iso -> rw.rvz (zstd)"
"$rom_weaver_bin" compress "$rvz_src" --format rvz --output "$rw_rvz" --codec zstd --threads 1 --json >/dev/null

# (2) dolphin-tool extracts rom-weaver's RVZ back to an ISO; must equal source.
rw_rvz_roundtrip="$rvz_dir/rw-roundtrip.iso"
log "dolphin-tool convert -f iso rw.rvz -> rw-roundtrip.iso"
run_dolphin convert -u "$dolphin_user" -i "$rw_rvz" -o "$rw_rvz_roundtrip" -f iso >/dev/null
if [[ ! -f "$rw_rvz_roundtrip" ]]; then
  log "ERROR: dolphin-tool produced no ISO from rom-weaver's RVZ"
  failures=$((failures + 1))
elif cmp -s "$rw_rvz_roundtrip" "$rvz_src"; then
  log "OK: dolphin-tool-extracted rom-weaver RVZ is byte-identical to the source"
else
  cmp "$rw_rvz_roundtrip" "$rvz_src" || true
  log "ERROR: dolphin-tool extract of rom-weaver's RVZ differs from source (sha1 want=$rvz_src_sha1 got=$(sha1_of "$rw_rvz_roundtrip"))"
  failures=$((failures + 1))
fi

# (3) Reverse: dolphin-tool creates an RVZ, rom-weaver extracts it; must equal
#     source.
ref_rvz="$rvz_dir/ref.rvz"
log "dolphin-tool convert -f rvz disc.iso -> ref.rvz"
run_dolphin convert -u "$dolphin_user" -i "$rvz_src" -o "$ref_rvz" -f rvz -c zstd -l 5 -b 131072 >/dev/null
[[ -f "$ref_rvz" ]] || fail "dolphin-tool produced no RVZ from the fixture ISO"
rw_rvz_extract_dir="$rvz_dir/ref-extract"
log "rom-weaver extract ref.rvz"
rw_extract_one "$ref_rvz" "$rw_rvz_extract_dir"
rvz_ref_extract="$rw_rvz_extract_dir/ref.iso"
if [[ ! -f "$rvz_ref_extract" ]]; then
  log "ERROR: rom-weaver did not emit ref.iso from dolphin-tool's RVZ; got: $(find "$rw_rvz_extract_dir" -maxdepth 1 -mindepth 1 -printf '%f ' 2>/dev/null)"
  failures=$((failures + 1))
elif cmp -s "$rvz_ref_extract" "$rvz_src"; then
  log "OK: rom-weaver-extracted dolphin-tool RVZ is byte-identical to the source"
else
  cmp "$rvz_ref_extract" "$rvz_src" || true
  log "ERROR: rom-weaver extract of dolphin-tool's RVZ differs from source (sha1 want=$rvz_src_sha1 got=$(sha1_of "$rvz_ref_extract"))"
  failures=$((failures + 1))
fi

# ===========================================================================
section "summary"
if [[ "$failures" -ne 0 ]]; then
  fail "$failures parity check(s) FAILED -- a vendored codec (lzma-rust2/flac/zstd/nod/ciso) may have regressed"
fi
log "all parity checks PASSED (CHD vs chdman, RVZ round-trip vs dolphin-tool)"
