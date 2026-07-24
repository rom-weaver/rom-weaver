#!/usr/bin/env bash
# Translate a positive list of wanted tools into the negative list mise expects.
#
# mise has no allowlist: MISE_DISABLE_TOOLS is the only lever, so a job that
# wants two of the eight pinned tools has to name the other six. Maintaining
# that by hand across every job means adding a tool to .config/mise.toml silently
# slows down every job that forgot to exclude it, and a typo in an exclusion is
# invisible - it just installs something extra.
#
# The full set is read from .config/mise.toml rather than duplicated here, so a new
# pin is excluded from every job by default and only the jobs that opt in pay
# for it. Each tool's short name is the final path segment of its mise id
# ("aqua:EmbarkStudios/cargo-deny" -> "cargo-deny"), and an unrecognized name
# is an error rather than a silent no-op.
#
# Usage: mise-disable-tools.sh <mise.toml> [wanted...]
#
# Sticks to bash 3.2 (no mapfile, no associative arrays): the macOS CI leg
# runs this under the runner's /bin/bash, which Apple froze at 3.2.
set -euo pipefail

config="${1:?usage: mise-disable-tools.sh <mise.toml> [wanted...]}"
shift

# Tool ids are the keys of the [tools] table: `node = "24"`, `"aqua:x/y" = "1"`.
ids=()
while IFS= read -r id; do
  [ -n "$id" ] && ids+=("$id")
done < <(
  sed -n '/^\[tools\]/,/^\[/p' "$config" |
    sed -n 's/^"\{0,1\}\([^"= ]*\)"\{0,1\}[[:space:]]*=.*/\1/p'
)

if [ "${#ids[@]}" -eq 0 ]; then
  echo "no tools found in [tools] of $config" >&2
  exit 1
fi

# Space-delimited membership sets; every name is a known short id, so the
# delimiters cannot collide with content.
wanted=" $* "
matched=" "

disable=()
for id in "${ids[@]}"; do
  short="${id##*/}"
  short="${short##*:}"
  case "$wanted" in
    *" $short "*) matched="$matched$short " ;;
    *) disable+=("$id") ;;
  esac
done

unknown=""
for name in "$@"; do
  case "$matched" in
    *" $name "*) ;;
    *) unknown="$unknown $name" ;;
  esac
done

if [ -n "$unknown" ]; then
  echo "unknown tool(s):$unknown - not pinned in $config" >&2
  exit 1
fi

# Empty output is valid: it means the job wants every pinned tool.
(
  IFS=,
  printf '%s\n' "${disable[*]-}"
)
