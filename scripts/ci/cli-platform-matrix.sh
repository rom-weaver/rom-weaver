#!/usr/bin/env bash
# Emit .github/cli-platforms.json as a one-line GitHub Actions matrix.
#
# The released CLI target list used to be pasted into four matrices - CI's
# build, and the release fan-out's build, dry-run, and publish - so CI could
# quietly stop covering a target the release still shipped. It lives in
# .github/cli-platforms.json now; every matrix reads it through this script.
#
# Fields, since JSON cannot carry comments:
#   package        npm platform package name under packages/rom-weaver-cli-platforms
#   runner         host that COMPILES the target (may be cross-compiling)
#   native_runner  host that can EXECUTE the built binary - the same as `runner`
#                  except for linux-arm64-musl, which cross-builds on x64
#   target         rustc target triple
#   build          "build" for cargo, "cross" for the cross-rs wrapper
#   binary         built file name (.exe on Windows)
#   msvc_arch,
#   msvc_host      VsDevCmd.bat arguments; Windows targets only
#   bootstrap      true only while a package has no trusted publisher yet and
#                  still needs NPM_BOOTSTRAP_TOKEN
#
# usage: scripts/ci/cli-platform-matrix.sh [file]
set -euo pipefail

file="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/cli-platforms.json}"

matrix=$(jq -c . "$file")
count=$(jq 'length' <<<"$matrix")
if [[ "$count" -lt 1 ]]; then
  echo "::error::$file lists no CLI platforms; refusing to emit an empty matrix" >&2
  exit 1
fi

printf '%s\n' "$matrix"
