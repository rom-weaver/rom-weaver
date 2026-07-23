#!/usr/bin/env bash
set -euo pipefail

log_file=$(mktemp)
trap 'rm -f "$log_file"' EXIT

# Wrangler resolves the Pages `functions/` directory relative to its cwd.
cd packages/rom-weaver-webapp
npx --yes wrangler@4 pages deploy dist \
  --project-name="$PROJECT" \
  --branch="$BRANCH" \
  --commit-hash="${GITHUB_SHA}" 2>&1 | tee "$log_file"

url=$(grep -oE 'https://[a-z0-9.-]+\.pages\.dev' "$log_file" | tail -1)
if [[ -z "$url" ]]; then
  echo "Cloudflare Pages deploy produced no pages.dev URL" >&2
  exit 1
fi
printf 'url=%s\n' "$url" >> "$GITHUB_OUTPUT"
echo "deployed to $url"
