#!/usr/bin/env bash
# Assert that every dependency of an aggregate CI check passed.
#
# The `rust` and `webapp` jobs exist to give branch protection one stable check
# name over a fan-out of parallel jobs. A skipped check counts as *passing* on
# GitHub, so the aggregate has to fail explicitly rather than skip - which means
# distinguishing "skipped because the path filter said this change cannot affect
# it" (fine) from "skipped because something upstream failed" (not fine).
#
# usage: scripts/ci/assert-jobs.sh <changes-result> <selected> <job>=<result>...
#   <changes-result>  needs.changes.result - must have succeeded, or the
#                     selection below is not trustworthy in the first place
#   <selected>        the changes-job output gating this group ("true" when the
#                     group was meant to run)
#   <job>=<result>    each dependency's needs.<job>.result
set -euo pipefail

changes_result="${1:-}"
selected="${2:-}"
shift 2 2>/dev/null || {
  echo "usage: scripts/ci/assert-jobs.sh <changes-result> <selected> <job>=<result>..." >&2
  exit 2
}
[[ $# -gt 0 ]] || {
  echo "usage: scripts/ci/assert-jobs.sh <changes-result> <selected> <job>=<result>..." >&2
  exit 2
}

failed=0

if [[ "$changes_result" != success ]]; then
  echo "::error::changes job reported '$changes_result'; cannot trust the selection"
  failed=1
fi

for pair in "$@"; do
  job="${pair%%=*}"
  result="${pair#*=}"
  if [[ "$result" == success ]]; then
    continue
  fi
  if [[ "$result" == skipped && "$selected" != true ]]; then
    echo "$job: skipped (group not selected for this change)"
    continue
  fi
  echo "::error::$job reported '$result' (group selected: ${selected:-unset})"
  failed=1
done

exit "$failed"
