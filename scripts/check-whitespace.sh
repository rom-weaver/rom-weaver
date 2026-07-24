#!/usr/bin/env bash
# Check for whitespace errors, skipping vendored third-party trees.
#
# One implementation for both callers - the lefthook pre-commit hook (no env,
# checks the staged diff) and CI (BASE_SHA/HEAD_SHA set, diffs the pull request
# range). They used to be separate copies of the same git invocation, so an
# exclusion added to one silently missed the other.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=vendored-pathspecs.sh
source scripts/vendored-pathspecs.sh

read_vendored_exclusions

base_sha="${BASE_SHA:-}"
head_sha="${HEAD_SHA:-}"
empty_sha=0000000000000000000000000000000000000000

if [[ -n "$base_sha" && "$base_sha" != "$empty_sha" && -n "$head_sha" ]]; then
  git diff --check "$base_sha" "$head_sha" -- . "${exclusions[@]}"
elif [[ -n "$head_sha" ]]; then
  git diff-tree --check --no-commit-id --exit-code -r "$head_sha" -- . "${exclusions[@]}"
else
  git diff --cached --check -- . "${exclusions[@]}"
fi
