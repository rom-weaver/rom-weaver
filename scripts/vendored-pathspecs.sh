#!/usr/bin/env bash
# Print one git pathspec per line excluding every vendored third-party tree.
#
# This is the single source of truth for "code we ship but did not write, and do
# not restyle". Style checks - whitespace, shellcheck, hadolint - consume it so
# the list lives in one place instead of being copy-pasted into each check and
# each of the two places every check runs (lefthook and CI).
#
# NOT consumed by clippy or rustfmt. The inlined Rust under src/ is deliberately
# held to the workspace lint policy and was adapted to pass it; see the comment
# above [workspace.lints] in the root Cargo.toml.
#
# Usage:  mapfile-style read into an array, then pass to a git command:
#           git ls-files -z -- '*.sh' "${exclusions[@]}"
set -euo pipefail

vendored=(
  # libarchive C sources - a verbatim upstream snapshot, refreshed wholesale by
  # scripts/vendor-libarchive.sh. Restyling it would turn each refresh into a merge.
  "crates/rom-weaver-containers/libarchive/vendor"
  # Inlined Rust from upstream projects. Excluded from style checks for the same
  # reason; still fully covered by clippy and rustfmt.
  "crates/rom-weaver-containers/src/nod"
  "crates/rom-weaver-containers/src/xdvdfs"
)

for path in "${vendored[@]}"; do
  printf ':(exclude)%s\n' "$path"
done
