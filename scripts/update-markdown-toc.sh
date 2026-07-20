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
    packages/rom-weaver-webapp/src/wasm/README.md
    scripts/wasm/README.md
  )
fi

npx --no-install doctoc \
  --github \
  --title "## Table of contents" \
  --toc-pragma-style compact \
  --toc-location before \
  --minlevel 2 \
  "${files[@]}"
