---
name: release
description: Start a rom-weaver release. Drafts the release highlights from the commits since the last tag, gets them approved, then dispatches the Release workflow with them so they head the changelog section, the release PR, and the GitHub release.
disable-model-invocation: true
---

# Release

Run from a clean checkout of the repository. Nothing here pushes a commit; the only write is the workflow dispatch, and it needs the user's approval first.

## 1. Collect the changes

```bash
git fetch origin --tags
last=$(git describe --tags --abbrev=0 origin/main)
git log "$last"..origin/main --format='%h %s'
```

Stop if the log is empty: there is nothing to release.

For every `feat`, `ux`, `fix`, `security`, `a11y`, `i18n`, `perf`, or breaking (`!`) commit, read the pull request description for what the change means to a user. Fetch them in one call:

```bash
for n in <numbers>; do gh pr view "$n" --json number,title,body --jq '"#\(.number) \(.title)\n\(.body)\n---"'; done
```

Skip non-breaking `chore`, `build`, `ci`, `deps`, `dx`, `test`, `docs`, and `refactor` commits; they land in the collapsed `All changes` list automatically.

## 2. Draft the highlights

Highlights are a quick, high-level answer to "what will I notice in this release?". A reader should get it in five seconds. The full detail is already in the collapsed `All changes` list, so leave it there.

Rules:

- Cover every user-facing change. Check each `feat`, `ux`, `fix`, `security`, `a11y`, `i18n`, `perf`, and breaking commit from step 1 against the bullets, and do not leave one out. Merge related commits into one bullet, so the list stays short; a user-facing change that has no bullet of its own is a mistake.
- Each bullet is one short line, at most 12 words. Plain words, present tense, no jargon. A concrete detail that a user would care about is welcome: a number or a name, as in "29 game save editors". Leave out flags, crate names, and internals.
- Add `(still in beta)` after a feature that lives in a tool that is still in beta: "in Save Editor (still in beta)". A bare `(beta)` tag is not enough. Check the pull request and the app's beta settings; when unsure, say so in the approval step.
- Name the app page where the feature lives when that helps a user find it: "on the Test page", "in Save Editor". Take the name from the app's navigation, and skip it for changes that span the whole app.
- Name the user benefit, not the change: "Faster compression", not "Parallelize hunk encoding".
- Leave out only what a user can never notice: CI, dependency bumps, tests, refactors, and build or hosting changes. Small fixes and wording tweaks still count.
- Every bullet MUST trace to a listed commit and MUST end with its pull request reference as `(#123)`. The workflow turns that into a link. When a bullet merges several commits, list every reference, each in its own parentheses. Never describe something the commits do not contain.
- Put a breaking change first and say what changes for the user in plain words, without flag names: "Command-line output is now compressed by default". The PR body has the exact flags; the release notes link there. The `⚠ BREAKING CHANGES` group also stays visible above the collapsed list.
- No heading, no trailing note, no markdown links. Bullets only.

- Good: `* Edit saves for 29 more games in Save Editor (still in beta) (#999)`
- Bad: `* Consume consistent JSONL cancellation and error details across the CLI output contract (#974)`

Before showing them, reread each bullet and cut any word that does not help a user decide whether the release matters to them.

Create `.agent/release/` if needed (`mkdir -p`), then write them to `.agent/release/highlights.md`, one bullet per line, `* ` prefix.

## 3. Get approval

Show the bullets, and say which version Release Please will compute (minor for a `feat` or a breaking change, patch otherwise; pre-1.0 breaking changes bump the minor). Ask whether to dispatch. A `release_as` override needs an explicit version from the user.

## 4. Dispatch

```bash
gh workflow run release.yml --ref main \
  -f highlights="$(cat .agent/release/highlights.md)"
```

Add `-f release_as=X.Y.Z` only when the user asked for a specific version.

Then report the run and the pull request when it appears:

```bash
gh run list --workflow release.yml --limit 1 --json url --jq '.[0].url'
gh pr list --label 'autorelease: pending' --json url --jq '.[0].url'
```

Delete `.agent/release/highlights.md` afterwards.

## What the workflow does with the input

`scripts/aggregate-release-changelog.mjs` writes `### Highlights`, keeps the generated breaking-change group visible, links the version heading to the tagged release, and puts the other generated entries inside a collapsed `All changes` block that opens with a `Compare` link to the commit range. It commits the section to the release pull request branch, copies it into the pull request body, and stores the highlights in a marked comment on the pull request. Release Please uses the pull request body for the GitHub release. Each dispatch rewrites the branch and body: a blank `highlights` input restores the stored highlights, and a non-empty input replaces them. To change the highlights after the pull request exists, run this skill again.
