#!/usr/bin/env bash
# Run a linter over every tracked file matching the given pathspecs, minus the
# vendored trees. One implementation for the shellcheck and hadolint tasks,
# which are the same three moves: resolve the exclusions, bail out cleanly when
# nothing matches, then feed the file list to the tool NUL-delimited.
#
# usage: scripts/lint-tracked.sh <pathspec>... -- <command>...
#   scripts/lint-tracked.sh '*.sh' -- shellcheck -x -P SCRIPTDIR
#
# git ls-files rather than a find walk: it skips node_modules for free, and only
# tracked files are ours to fix.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=vendored-pathspecs.sh
source scripts/vendored-pathspecs.sh

usage() {
  echo "usage: scripts/lint-tracked.sh <pathspec>... -- <command>..." >&2
  exit 2
}

patterns=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  patterns+=("$1")
  shift
done
[[ ${#patterns[@]} -gt 0 && "${1:-}" == "--" ]] || usage
shift
[[ $# -gt 0 ]] || usage

read_vendored_exclusions
if [[ -z "$(git ls-files -- "${patterns[@]}" "${exclusions[@]}")" ]]; then
  echo "$1: no tracked files matching ${patterns[*]}" >&2
  exit 0
fi
git ls-files -z -- "${patterns[@]}" "${exclusions[@]}" | xargs -0 "$@"
