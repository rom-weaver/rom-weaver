---
name: release
description: Draft rom-weaver release highlights and optionally start a release. Use --notes-only to show the notes and predicted version without dispatching; otherwise get approval before running the Release workflow.
disable-model-invocation: true
---

# Release

Run from a clean checkout of the repository. Nothing here pushes a commit. The skill writes a local highlights draft; dispatching the workflow requires the user's approval.

## Modes

- `release --notes-only`: collect changes, draft highlights, and show them with the predicted version. Stop there: do not ask to dispatch or run a workflow. Keep the local draft.
- `release`: draft highlights, get approval, then dispatch the workflow.

## 1. Collect the changes

```bash
git fetch origin --tags
last=$(git describe --tags --abbrev=0 origin/main)
git log "$last"..origin/main --format='%h %s'
```

Stop if the log is empty: there is nothing to release.

Read the pull request descriptions for `feat`, `ux`, `fix`, `security`, `a11y`, `i18n`, `perf`, and breaking (`!`) commits to identify user-facing themes. Fetch them in one call:

```bash
for n in <numbers>; do gh pr view "$n" --json number,title,body --jq '"#\(.number) \(.title)\n\(.body)\n---"'; done
```

Skip non-breaking `chore`, `build`, `ci`, `deps`, `dx`, `test`, `docs`, and `refactor` commits; they land in the collapsed `All changes` list automatically.

## 2. Draft the highlights

Highlights explain meaningful user-visible changes concisely. Keep enough detail for readers to recognize what they can now do or which problem was fixed. The collapsed `All changes` list provides complete coverage.

Group changes to the same workflow when their concrete outcomes remain clear. Do not merge unrelated improvements just because both make the app easier or more reliable. Shorten by removing repetition and minor details, not the information that makes a highlight useful.

Rules:

- Select the strongest benefits before grouping them under `#### New features`, `#### Improvements`, `#### Fixes`, and `#### Security`, in that order. Omit unused sections even when matching commits exist. Choose the section by the user-visible outcome, not just the commit type; put each bullet in one section only.
- Lead each section with its strongest bullet. The webapp's update banner shows only the first highlight of the newest release it announces; What's new has the rest.
- Use no fixed count or section quotas. Include distinct new capabilities, meaningful workflow improvements, and notable fixes. A capability can matter to a specific audience without defining the whole release; do not discard it just to shorten the list. Leave routine polish and maintenance in `All changes`.
- Each bullet is one concise sentence in plain words. Name the affected task, tool, or format and the concrete result. Keep necessary scope and conditions, even when that needs more words. Avoid vague summaries such as "more tools", "better handling", or "more reliable" without saying what changed. Leave out flags, crate names, and internals.
- Add `(still in beta)` after a feature that lives in a tool that is still in beta: "in Save Editor (still in beta)". A bare `(beta)` tag is not enough. Check the pull request and the app's beta settings; when unsure, say so when showing the notes.
- Name the app page where the feature lives when that helps a user find it: "on the Test page", "in Save Editor". Take the name from the app's navigation, and skip it for changes that span the whole app.
- Explain the user benefit through the changed behavior, rather than implementation details or a generic positive claim.
- Highlight fixes that restore an important workflow, prevent lost files or incorrect results, or address material security risks. Name the affected case instead of listing each failure mode. A `fix` or `security` commit does not automatically need a headline; leave minor repairs and internal hardening in `All changes`.
- Every bullet MUST trace to listed commits and end with supporting pull request references as `(#123)`. The workflow turns them into links. Cite only the PRs needed to substantiate the headline, not every related change. When grouping changes, preserve their scope and conditions; do not turn separate fixes into a broader guarantee.
- Put breaking changes in a `#### Breaking changes` section before all other highlights. Say what changes for the user in plain words, without flag names: "Command-line output is now compressed by default". The PR body has the exact flags; the release notes link there. The generated `⚠ BREAKING CHANGES` group also stays visible above the collapsed list.
- Always include required migration actions and urgent security notices.
- Use only section headings and bullets. Put blank lines around headings, but no blank lines between bullets within a section. Do not add a top-level Highlights heading, introductory text, trailing notes, or markdown links; the workflow adds `### Highlights`.

- Good: `* Edit saves for 29 more games in Save Editor (still in beta) (#999)`
- Bad: `* Improve save tools and make file handling more reliable (#999)`
- Bad: `* Consume consistent JSONL cancellation and error details across the CLI output contract (#974)`

Before showing them, check both selection and specificity: remove repetition and routine details, restore distinct capabilities lost through over-grouping, and replace vague benefits with concrete outcomes. Do not hide unrelated fixes inside a catch-all bullet. Check grouped claims against their sources. Judge the result by useful information and readability, not its bullet count.

Create `.agent/release/` if needed (`mkdir -p`), then write the section headings and bullets to `.agent/release/highlights.md`. Keep one bullet per line with a `* ` prefix.

## 3. Show the notes

Show the sectioned highlights, and say which version Release Please will compute (minor for a `feat` or a breaking change, patch otherwise; pre-1.0 breaking changes bump the minor).

With `--notes-only`, stop here. Otherwise, ask whether to dispatch. A `release_as` override needs an explicit version from the user.

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
