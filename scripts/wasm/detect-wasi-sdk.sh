#!/usr/bin/env sh

# Print the WASI SDK root, or nothing if none is found.
#
# Resolution order (first hit wins):
#   1. $WASI_SDK_PATH, if it already points at a real directory (CI sets this).
#   2. each fixed location: the arguments, or the two defaults below.
#   3. newest $HOME/.local/toolchains/wasi-sdk-*
#
# POSIX shell rather than Node.js on purpose. .config/mise.toml runs this while
# rendering [env], which mise does *before* it installs the [tools] it pins - so
# a Node.js implementation cannot run during a fresh bootstrap, and a machine
# without a system node fails every mise command in the repo with a template
# error that never mentions Node.js. Every system that can run mise has a shell.
#
# Kept outside mise tools so the SDK's clang does not shadow the host clang and
# break libarchive-sys bindgen on macOS. Absence still exits successfully, so
# only WASM build tasks fail on a missing SDK. Printing a directory that is not
# an SDK is worse than printing nothing: .config/mise.toml derives WASI_SYSROOT
# and WASI_CLANG from this, so a wrong root turns "no SDK installed" into a
# confusing missing-file error deep inside a build.

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

# `sort -V` is what keeps wasi-sdk-9 behind wasi-sdk-25; plain sort orders them
# lexically and picks 9. It is a GNU/BSD extension rather than POSIX, present on
# both macOS and Linux - and the Windows CI leg does not use mise at all (see
# docs/ci.md), which is the only place without it.
#
# The glob is expanded by the loop rather than parsed out of `ls` so a path
# containing whitespace survives.
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
