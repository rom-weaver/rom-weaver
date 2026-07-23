#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  echo "::notice::CLOUDFLARE_ZONE_ID not set; skipping zone cache rule"
  exit 0
fi

api="https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/rulesets"
desc="rom-weaver: cache immutable /assets (managed by ci.yml)"
expr='(http.host in {"rom-weaver.com" "beta.rom-weaver.com" "nightly.rom-weaver.com"}) and starts_with(http.request.uri.path, "/assets/")'
rule=$(jq -cn --arg desc "$desc" --arg expr "$expr" '{
  description: $desc,
  expression: $expr,
  action: "set_cache_settings",
  action_parameters: { cache: true, edge_ttl: { mode: "respect_origin" } },
  enabled: true
}')

entry_file=$(mktemp)
trap 'rm -f "$entry_file"' EXIT
if ! entry_status=$(curl -sS -o "$entry_file" -w '%{http_code}' \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "$api/phases/http_request_cache_settings/entrypoint"); then
  echo "failed to read the Cloudflare cache ruleset" >&2
  exit 1
fi

if [[ "$entry_status" == 404 ]]; then
  rules='[]'
elif [[ "$entry_status" != 200 ]]; then
  echo "Cloudflare cache ruleset read returned HTTP $entry_status" >&2
  jq . "$entry_file" >&2 || cat "$entry_file" >&2
  exit 1
else
  if [[ "$(jq -r '.success // false' "$entry_file")" != true ]]; then
    echo "Cloudflare cache ruleset read was not successful" >&2
    jq . "$entry_file" >&2 || cat "$entry_file" >&2
    exit 1
  fi
  rules=$(jq -e -c '.result.rules // []' "$entry_file")
fi

if jq -e --arg desc "$desc" --arg expr "$expr" \
  'any(.[]; .description == $desc and .expression == $expr)' <<<"$rules" >/dev/null; then
  echo "zone cache rule already present"
  exit 0
fi

merged=$(jq -c --argjson rule "$rule" --arg desc "$desc" \
  '[.[] | select(.description != $desc)] + [$rule]' <<<"$rules")
body=$(curl -sS -X PUT "$api/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$(jq -cn --argjson rules "$merged" '{rules: $rules}')")
if [[ "$(jq -r '.success // false' <<<"$body")" == true ]]; then
  echo "zone cache rule installed"
else
  echo "unexpected response installing zone cache rule:" >&2
  jq . <<<"$body" >&2 || printf '%s\n' "$body" >&2
  exit 1
fi
