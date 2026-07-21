#!/usr/bin/env bash
# Refresh the inlined libarchive C sources under
# crates/rom-weaver-containers/libarchive/vendor/libarchive/.
#
# The inlined tree is the only libarchive source rom-weaver builds, locally and
# on crates.io alike. Local patches are developed in the fork
# (https://github.com/brandonocasey/libarchive) and copied in from here, so the
# fork keeps the reviewable history against upstream and this tree stays a
# verbatim - if pruned - snapshot of one commit.
#
# Nothing dropped below is ever compiled: the test trees are excluded by
# ENABLE_TEST=OFF in build.rs, and the rest is documentation. Upstream still
# calls add_subdirectory(test) unconditionally, so build.rs strips those five
# calls from its staged copy - keep the two lists in sync
# (TEST_SUBDIRECTORY_OWNERS in crates/rom-weaver-containers/libarchive/build.rs).
#
# Pruning anything else CMake reads would force an edit to the vendored tree and
# turn every future refresh from a copy into a merge. Don't.
#
# Usage:  scripts/vendor-libarchive.sh <path-to-libarchive-checkout> [ref]
# Re-runnable.
set -euo pipefail

source_dir="${1:-}"
ref="${2:-HEAD}"

if [ -z "$source_dir" ]; then
  echo "usage: scripts/vendor-libarchive.sh <path-to-libarchive-checkout> [ref]" >&2
  exit 1
fi
if [ ! -f "$source_dir/CMakeLists.txt" ]; then
  echo "vendor-libarchive: $source_dir is not a libarchive checkout" >&2
  exit 1
fi

repo_dir="$(git rev-parse --show-toplevel)"
dest_dir="$repo_dir/crates/rom-weaver-containers/libarchive/vendor/libarchive"

# Resolve provenance from the source checkout before touching anything, so a
# detached or dirty tree fails here rather than half way through the copy.
commit="$(git -C "$source_dir" rev-parse "$ref")"
described="$(git -C "$source_dir" describe --tags "$ref" 2>/dev/null || echo "$commit")"
if ! git -C "$source_dir" diff --quiet "$ref" -- 2>/dev/null; then
  echo "vendor-libarchive: $source_dir has uncommitted changes against $ref" >&2
  exit 1
fi

# Test data alone is ~13 MB of the ~20 MB tree and never compiles; dropping it
# is what keeps the published crate well under the crates.io 10 MiB cap.
prune=(
  ".git"
  ".github"
  ".cirrus.yml"
  "libarchive/test"
  "cat/test"
  "cpio/test"
  "tar/test"
  "unzip/test"
  "test_utils"
  "doc"
  "examples"
  "contrib"
  # Upstream's own release and CI tooling. CMake reads only build/cmake,
  # build/pkgconfig, and build/version; the rest serves the autotools build and
  # upstream's CI. Dropping it also keeps this repo's shellcheck and hadolint
  # runs - which lint every tracked file - off upstream's scripts and images.
  "build/autoconf"
  "build/ci"
  "build/release"
  "build/utils"
  "build/autogen.sh"
  "build/bump-version.sh"
  "build/clean.sh"
  "build/makerelease.sh"
)

echo "vendor-libarchive: staging $described ($commit)"
staged="$(mktemp -d)"
trap 'rm -rf "$staged"' EXIT
git -C "$source_dir" archive --format=tar "$ref" | tar -x -C "$staged"

for path in "${prune[@]}"; do
  rm -rf "${staged:?}/$path"
done

rm -rf "$dest_dir"
mkdir -p "$(dirname "$dest_dir")"
mv "$staged" "$dest_dir"
trap - EXIT
chmod -R u+w "$dest_dir"

cat >"$dest_dir/../LIBARCHIVE_VERSION" <<EOF
source: https://github.com/brandonocasey/libarchive
ref: $described
commit: $commit
pruned: ${prune[*]}
refreshed-by: scripts/vendor-libarchive.sh
EOF

echo "vendor-libarchive: wrote $dest_dir ($described)"
echo "vendor-libarchive: now run"
echo "  cargo test -p rom-weaver-containers"
echo "  cargo test -p rom-weaver-cli --test cli_smoke"
echo "  mise run build-wasm"
