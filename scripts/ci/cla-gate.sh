#!/usr/bin/env bash
#
# Post the required `license/cla` commit status for a pull request, and record
# signatures given by comment.
#
# This replaces the hosted CLA Assistant app, which only ever posted in response
# to a `pull_request` event and left a force-pushed head permanently without a
# status - an unmergeable pull request with no re-run button anywhere. A
# workflow reruns on demand, fires on `synchronize` (which force-pushes emit),
# and always targets the current head SHA.
#
# Policy (the allowlist) lives on the default branch where it is review-gated;
# signature data lives on the unprotected SIGNATURES_BRANCH, because the ruleset
# on the default branch forbids direct pushes and grants no bypass actors.
#
# Required env:
#   GH_TOKEN            token with statuses:write, pull-requests:write, contents:write
#   GITHUB_REPOSITORY   owner/repo
#   PR_NUMBER           pull request number
#   COMMENT_BODY        body of the triggering comment (empty for pull_request events)
#   COMMENT_AUTHOR      login of the comment author (empty for pull_request events)
set -euo pipefail

SIGNATURES_BRANCH=${SIGNATURES_BRANCH:-cla-signatures}
SIGNATURES_PATH=${SIGNATURES_PATH:-signatures.json}
ALLOWLIST_FILE=${ALLOWLIST_FILE:-.github/cla-allowlist.txt}
CLA_DOCUMENT=${CLA_DOCUMENT:-https://github.com/${GITHUB_REPOSITORY}/blob/main/CLA.md}
# Quoted verbatim in CLA.md section 7. Changing it here without changing it
# there leaves contributors typing a phrase this gate will not accept.
SIGN_PHRASE="I have read the CLA Document and I hereby sign the CLA"
COMMENT_MARKER="<!-- rom-weaver-cla-gate -->"

pr=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")
head_sha=$(jq -r '.head.sha' <<<"$pr")

# `login` is null for commits whose author email matches no GitHub account.
# Those cannot sign by comment, so they are reported by name instead of being
# silently dropped.
#
# Assigned in two steps rather than through a pipeline so that a failed fetch
# aborts instead of quietly shrinking the set of people who have to sign.
# Newline-delimited strings throughout, not arrays: macOS ships bash 3.2, which
# has no `mapfile`.
commit_authors=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/commits" \
  --jq '.[] | (.author.login // ("unlinked:" + .commit.author.name))')
authors=$(printf '%s\n%s\n' "$(jq -r '.user.login' <<<"$pr")" "$commit_authors" |
  grep -v '^$' | sort -u)

# Globs, one per line; `#` comments and blank lines ignored. `*[bot]` is what
# exempts Dependabot, release-please and every other bot - a bot has no
# copyright to grant, and cannot comment a signature anyway.
allowed() {
  local login=$1 pattern
  [[ -f $ALLOWLIST_FILE ]] || return 1
  while IFS= read -r pattern; do
    pattern=${pattern%%#*}
    pattern=$(tr -d '[:space:]' <<<"$pattern")
    [[ -n $pattern ]] || continue
    # Brackets are literal, not a character class: every bot login ends in the
    # four characters `[bot]`, and an unescaped `*[bot]` would instead match
    # anything ending in b, o or t. `*` and `?` stay wildcards.
    pattern=${pattern//\[/\\[}
    pattern=${pattern//\]/\\]}
    # shellcheck disable=SC2053 # unquoted RHS is the glob match, on purpose
    [[ $login == $pattern ]] && return 0
  done <"$ALLOWLIST_FILE"
  return 1
}

read_signatures() {
  local response
  if ! response=$(gh api \
    "repos/${GITHUB_REPOSITORY}/contents/${SIGNATURES_PATH}?ref=${SIGNATURES_BRANCH}" 2>/dev/null); then
    printf '{"sha":"","signatures":[]}'
    return
  fi
  jq -c '{sha: .sha, signatures: (.content | @base64d | fromjson)}' <<<"$response"
}

signatures_state=$(read_signatures)
signed=$(jq -r '.signatures[].login' <<<"$signatures_state")

has_signed() {
  grep -qxF "$1" <<<"$signed"
}

# A comment carrying the phrase signs for its author, but only when that author
# actually owes a signature on this pull request - otherwise anyone could
# append themselves to the file from any thread.
if [[ ${COMMENT_BODY:-} == *"$SIGN_PHRASE"* && -n ${COMMENT_AUTHOR:-} ]] &&
  grep -qxF "$COMMENT_AUTHOR" <<<"$authors" &&
  ! has_signed "$COMMENT_AUTHOR" && ! allowed "$COMMENT_AUTHOR"; then

  signer_id=$(gh api "users/${COMMENT_AUTHOR}" --jq '.id')
  signed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  updated=$(jq \
    --arg login "$COMMENT_AUTHOR" \
    --argjson id "$signer_id" \
    --argjson pr "$PR_NUMBER" \
    --arg at "$signed_at" \
    --arg cla "$CLA_DOCUMENT" \
    '.signatures + [{login: $login, id: $id, pullRequest: $pr, signedAt: $at, cla: $cla}]' \
    <<<"$signatures_state")

  args=(
    --method PUT
    --field message="chore(cla): record signature from ${COMMENT_AUTHOR} (#${PR_NUMBER})"
    --field branch="$SIGNATURES_BRANCH"
    --field content="$(printf '%s\n' "$updated" | base64 | tr -d '\n')"
  )
  # Absent on the very first signature, when the PUT creates the file. Passing
  # an empty sha is an error, so omit the field entirely.
  existing_sha=$(jq -r '.sha' <<<"$signatures_state")
  if [[ -n $existing_sha ]]; then
    args+=(--field sha="$existing_sha")
  fi

  gh api "repos/${GITHUB_REPOSITORY}/contents/${SIGNATURES_PATH}" "${args[@]}" --silent
  echo "recorded CLA signature from ${COMMENT_AUTHOR}"

  signatures_state=$(read_signatures)
  signed=$(jq -r '.signatures[].login' <<<"$signatures_state")
fi

unsigned=""
while IFS= read -r author; do
  [[ -n $author ]] || continue
  allowed "$author" && continue
  has_signed "$author" && continue
  unsigned+="${author}"$'\n'
done <<<"$authors"

post_status() {
  gh api "repos/${GITHUB_REPOSITORY}/statuses/${head_sha}" \
    --method POST \
    --field state="$1" \
    --field context='license/cla' \
    --field description="$2" \
    --field target_url="$3" \
    --silent
}

# One comment per pull request, edited in place, so a rebase does not bury the
# thread under duplicates. `--edit-only` skips creating one at all, which keeps
# the overwhelmingly common case - a pull request from someone who has already
# signed - completely silent.
upsert_comment() {
  local body=$1 edit_only=${2:-} existing
  existing=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
    --jq "map(select(.body | contains(\"${COMMENT_MARKER}\"))) | .[0].id // empty")
  if [[ -n $existing ]]; then
    gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" \
      --method PATCH --field body="$body" --silent
  elif [[ -z $edit_only ]]; then
    gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
      --method POST --field body="$body" --silent
  fi
}

run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-}"

if [[ -z $unsigned ]]; then
  post_status success 'All contributors have signed the CLA' "$CLA_DOCUMENT"
  upsert_comment "${COMMENT_MARKER}
**CLA signed.** All contributors to this pull request have signed the
[Contributor License Agreement](${CLA_DOCUMENT})." --edit-only
  echo "license/cla success on ${head_sha} (authors: $(tr '\n' ' ' <<<"$authors"))"
  exit 0
fi

count=$(grep -c . <<<"$unsigned")
post_status failure "Awaiting CLA signature from ${count} contributor(s)" "$run_url"

list=$(awk 'NF {print "- @" $0}' <<<"$unsigned")
upsert_comment "${COMMENT_MARKER}
**CLA signature required.**

${list}

Please read the [Contributor License Agreement](${CLA_DOCUMENT}) and, if you
agree, post a new comment containing exactly:

> ${SIGN_PHRASE}

Signing covers all of your past and future contributions. Comment \`recheck\` at
any time to re-run this check.

Commits listed as \`unlinked:<name>\` have an author email that matches no
GitHub account - fix the commit author or say so in the thread."

echo "license/cla failure on ${head_sha}; unsigned: $(tr '\n' ' ' <<<"$unsigned")" >&2
exit 1
