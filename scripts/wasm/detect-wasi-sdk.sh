#!/usr/bin/env sh

# Find a directory using WASI_SDK_PATH, the supplied or default paths, then the
# newest $HOME/.local/toolchains/wasi-sdk-* entry; absence is not an error.
#
# SDK discovery MUST work before mise installs Node.js, so it uses shell tools.
# Keeping the SDK off PATH prevents its clang from replacing the native compiler.

set -eu

if [ "$#" -eq 0 ]; then
  set -- /opt/wasi-sdk /opt/homebrew/opt/wasi-sdk
fi

if [ -n "${WASI_SDK_PATH:-}" ] && [ -d "${WASI_SDK_PATH}" ]; then
  printf %s "${WASI_SDK_PATH}"
  exit 0
fi

for candidate in "$@"; do
  if [ -d "${candidate}" ]; then
    printf %s "${candidate}"
    exit 0
  fi
done

# Version sorting puts wasi-sdk-25 after wasi-sdk-9; this requires sort -V.
# The loop preserves whitespace within each path.
newest=$(
  for toolchain in "${HOME:-}"/.local/toolchains/wasi-sdk-*; do
    if [ -d "${toolchain}" ]; then
      printf '%s\n' "${toolchain}"
    fi
  done | sort -V | tail -n 1
)

if [ -n "${newest}" ]; then
  printf %s "${newest}"
fi
