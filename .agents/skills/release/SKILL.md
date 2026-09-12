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

For every `feat`, `fix`, `perf`, or breaking (`!`) commit, read the pull request description for what the change means to a user:

```bash
gh pr view <number> --json title,body --jq '.title + "\n\n" + .body'
```

Skip non-breaking `chore`, `build`, `ci`, `test`, `docs`, `style`, and `refactor` commits; they land in the collapsed `All changes` list automatically.

## 2. Draft the highlights

Write 3 to 6 bullets. Rules:

- Every bullet MUST trace to a listed commit and MUST end with its pull request reference in the form `(#123)`. The workflow turns that into a link. Never describe something the commits do not contain.
- Lead with what a user can now do, not with the implementation. One sentence, plain words, present tense: "Play CHD discs on the Test page (#709)".
- Group several small commits into one bullet when they tell one story, and list every reference, each in its own parentheses: "Clearer navigation with a Find page (#634) (#710)".
- Put a breaking change first and say what a user has to change. The `⚠ BREAKING CHANGES` group also stays visible above the collapsed list.
- No heading, no trailing note, no markdown links. Bullets only.

Write them to `/tmp/release-highlights.md`, one bullet per line, `* ` prefix.

## 3. Get approval

Show the bullets, and say which version Release Please will compute (minor for a `feat` or a breaking change, patch otherwise; pre-1.0 breaking changes bump the minor). Ask whether to dispatch. A `release_as` override needs an explicit version from the user.

## 4. Dispatch

```bash
gh workflow run release.yml --ref main \
  -f highlights="$(cat /tmp/release-highlights.md)"
```

Add `-f release_as=X.Y.Z` only when the user asked for a specific version.

Then report the run and the pull request when it appears:

```bash
gh run list --workflow release.yml --limit 1 --json url --jq '.[0].url'
gh pr list --label 'autorelease: pending' --json url --jq '.[0].url'
```

Delete `/tmp/release-highlights.md` afterwards.

## What the workflow does with the input

`scripts/aggregate-release-changelog.mjs` writes `### Highlights`, keeps the generated breaking-change group visible, and puts the other generated entries inside a collapsed `All changes` block. It commits the section to the release pull request branch, copies it into the pull request body, and stores the highlights in a marked comment on the pull request. Release Please uses the pull request body for the GitHub release. Each dispatch rewrites the branch and body: a blank `highlights` input restores the stored highlights, and a non-empty input replaces them. To change the highlights after the pull request exists, run this skill again.
