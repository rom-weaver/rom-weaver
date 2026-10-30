#!/bin/sh
# Thin POSIX wrapper: run the native CLI apply matrix (see README.md).
# Usage: scripts/apply-matrix/cli/run.sh [--filter bps,container.zip] [--list] [--strict] ...
set -eu
unset CDPATH
here=$(cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/run.mjs" "$@"
