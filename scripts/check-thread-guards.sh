#!/usr/bin/env bash
set -euo pipefail

# Plain grep, not ripgrep: this guard was most of what kept rg pinned and
# installed across CI jobs. POSIX classes ([[:space:]]) over GNU \s so the
# patterns behave the same under BSD grep on macOS. -I skips the wasm blobs
# that sit untracked under packages/rom-weaver-webapp/src/wasm, which rg used
# to exclude by reading .gitignore.
failed=0

# src/chd (the folded rom-weaver-chd crate, never in this guard's scope) uses the
# cfg pair for its decode heap-pregrow, which enables threaded wasm rather than
# suppressing it.
if grep -rnIE 'wasm_threaded_runtime_.*is_unstable|target_family = "wasm", rom_weaver_wasi_threads' \
  --exclude-dir=chd crates/rom-weaver-containers/src; then
  echo "container handlers should not suppress threaded WASM execution" >&2
  failed=1
fi

# browser-format-matrix.ts legitimately declares per-format `threads: 1` expectations.
if grep -rnIE 'threads:[[:space:]]*1([^0-9]|$)|toThreadArg\([^)]*,[[:space:]]*["'\'']1["'\'']\)' \
  --exclude=browser-format-matrix.ts packages/rom-weaver-webapp/src; then
  echo "browser runtime should not force single-threaded execution" >&2
  failed=1
fi

exit "$failed"
