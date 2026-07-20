#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep is required for thread guard regression checks" >&2
  exit 127
fi

failed=0

# src/chd (the folded rom-weaver-chd crate, never in this guard's scope) uses the
# cfg pair for its decode heap-pregrow, which enables threaded wasm rather than
# suppressing it.
if rg -n 'wasm_threaded_runtime_.*is_unstable|target_family = "wasm", rom_weaver_wasi_threads' -g '!**/chd/**' crates/rom-weaver-containers/src; then
  echo "container handlers should not suppress threaded WASM execution" >&2
  failed=1
fi

# browser-format-matrix.ts legitimately declares per-format `threads: 1` expectations.
if rg -n 'threads:\s*1\b|toThreadArg\([^)]*,\s*["'\'']1["'\'']\)' -g '!**/browser-format-matrix.ts' packages/rom-weaver-webapp/src; then
  echo "browser runtime should not force single-threaded execution" >&2
  failed=1
fi

exit "$failed"
