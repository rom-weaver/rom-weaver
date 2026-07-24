#!/usr/bin/env bash
# Git pathspecs excluding every vendored third-party tree.
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
# Executed: prints one pathspec per line.
# Sourced:  call `read_vendored_exclusions`, then pass the array it fills:
#             read_vendored_exclusions
#             git ls-files -z -- '*.sh' "${exclusions[@]}"

vendored_pathspecs() {
  local vendored=(
    # libarchive C sources - a verbatim upstream snapshot, refreshed wholesale by
    # scripts/vendor-libarchive.sh. Restyling it would turn each refresh into a merge.
    "crates/rom-weaver-containers/libarchive/vendor"
    # Inlined Rust from upstream projects. Excluded from style checks for the same
    # reason; still fully covered by clippy and rustfmt.
    "crates/rom-weaver-containers/src/nod"
    "crates/rom-weaver-containers/src/xdvdfs"
  )

  local path
  for path in "${vendored[@]}"; do
    printf ':(exclude)%s\n' "$path"
  done
}

# Fills the caller's `exclusions` array. Deliberately not a subshell-captured
# string: pathspecs must survive as separate argv entries.
read_vendored_exclusions() {
  exclusions=()
  local pathspec
  while IFS= read -r pathspec; do
    exclusions+=("$pathspec")
  done < <(vendored_pathspecs)
}

# Only when run as a program; sourcing must not disturb the caller's shell
# options or print anything.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  vendored_pathspecs
fi
