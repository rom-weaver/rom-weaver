#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep is required for thread guard regression checks" >&2
  exit 127
fi

failed=0

if rg -n 'wasm_threaded_runtime_.*is_unstable|target_family = "wasm", rom_weaver_wasi_threads' crates/rom-weaver-containers/src; then
  echo "container handlers should not suppress threaded WASM execution" >&2
  failed=1
fi

if rg -n 'workerThreads:\s*1|toThreadArg\([^)]*,\s*["'\'']1["'\'']\)' packages/rom-weaver-react/src; then
  echo "browser runtime should not force single-threaded execution" >&2
  failed=1
fi

exit "$failed"
