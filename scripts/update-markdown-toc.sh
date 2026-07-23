#!/usr/bin/env bash
set -euo pipefail

files=("$@")
if ((${#files[@]} == 0)); then
  files=(
    README.md
    docs
    .github/CODE_OF_CONDUCT.md
    .github/CONTRIBUTING.md
    .github/RELEASING.md
    .github/SECURITY.md
    packages/rom-weaver-webapp/design/icon-masters/README.md
    packages/rom-weaver-wasm/src/README.md
    scripts/wasm/README.md
  )
fi

# doctoc only filters by extension when it walks a directory; an explicit file
# argument is rewritten whatever it is. lefthook hands us the staged paths under
# docs/, so without this guard a staged docs/*.json gets TOC markers appended
# and stops being valid JSON.
readme=false
other_files=()
for file in "${files[@]}"; do
  if [[ "$file" == README.md ]]; then
    readme=true
  elif [[ -d "$file" || "$file" == *.md ]]; then
    other_files+=("$file")
  fi
done

doctoc=(
  npx --no-install doctoc
  --github
  --toc-pragma-style compact
  --toc-location before
  --minlevel 2
)

if [[ "$readme" == true ]]; then
  "${doctoc[@]}" --notitle --maxlevel 2 README.md
fi

if ((${#other_files[@]})); then
  "${doctoc[@]}" --title "## Table of contents" "${other_files[@]}"
fi
