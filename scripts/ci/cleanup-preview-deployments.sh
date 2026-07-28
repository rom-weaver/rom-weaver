#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${PREVIEW_ENVIRONMENT:?PREVIEW_ENVIRONMENT is required}"
: "${PR_HEAD_REF:?PR_HEAD_REF is required}"

deployments=$(
  gh api --method GET --paginate "repos/${GH_REPO}/deployments" \
    -f ref="$PR_HEAD_REF" \
    -f environment="$PREVIEW_ENVIRONMENT" \
    -f per_page=100
)
ids=$(
  jq -sr '
    add
    | sort_by(.created_at, .id)
    | reverse
    | .[].id
  ' <<< "$deployments"
)

deleted=0
kept_failure=false
while read -r id; do
  [[ -n "$id" ]] || continue
  state=$(
    gh api "repos/${GH_REPO}/deployments/${id}/statuses" \
      --jq '.[0].state // "unknown"'
  )
  case "$state" in
    inactive) ;;
    error | failure)
      if [[ "$kept_failure" == false ]]; then
        kept_failure=true
        continue
      fi
      ;;
    *) continue ;;
  esac

  gh api --method DELETE "repos/${GH_REPO}/deployments/${id}"
  deleted=$((deleted + 1))
done <<< "$ids"

echo "deleted ${deleted} superseded GitHub preview deployment(s) for ${PR_HEAD_REF}"
