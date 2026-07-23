#!/usr/bin/env bash
set -euo pipefail

api="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects"
body=$(curl -sS -X POST "$api" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$(jq -cn --arg name "$PROJECT" '{name: $name, production_branch: "main"}')")

if [[ "$(jq -r '.success // false' <<<"$body")" == true ]]; then
  echo "created Pages project '$PROJECT'"
elif jq -e '.errors[]? | select(.code == 8000002 or (.message | test("already exists"; "i")))' <<<"$body" >/dev/null; then
  echo "Pages project '$PROJECT' already exists"
else
  echo "unexpected response creating '$PROJECT':" >&2
  jq . <<<"$body" >&2 || printf '%s\n' "$body" >&2
  exit 1
fi
