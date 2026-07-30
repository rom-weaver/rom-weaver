# Continuous integration

Every workflow in `.github/workflows`, what triggers it, what it gates, and
what it caches. For the release *decision* - versions, tags, trusted
publishing, and retry procedures - see the [release guide](../../.github/RELEASING.md).

<!-- START doctoc -->
## Table of contents

- [The workflows at a glance](#the-workflows-at-a-glance)
- [`ci.yml` - the required gate](#ciyml---the-required-gate)
  - [Jobs](#jobs)
  - [Performance budgets](#performance-budgets)
  - [Tag runs](#tag-runs)
  - [Deploy channels](#deploy-channels)
- [Shared building blocks](#shared-building-blocks)
  - [`.github/actions/setup-build-env`](#githubactionssetup-build-env)
  - [`.github/actions/wasm-cache`](#githubactionswasm-cache)
  - [`.github/actions/build-cli-platform`](#githubactionsbuild-cli-platform)
  - [`.github/actions/docker-build-arch` and `docker-manifest`](#githubactionsdocker-build-arch-and-docker-manifest)
  - [`.github/cli-platforms.json`](#githubcli-platformsjson)
  - [macOS support floor](#macos-support-floor)
  - [`scripts/ci/assert-jobs.mjs`](#scriptsciassert-jobsmjs)
  - [`scripts/ci/classify-changes.mjs`](#scriptsciclassify-changesmjs)
  - [`scripts/ci/resolve-wasm-run.mjs`](#scriptsciresolve-wasm-runmjs)
  - [`scripts/ci/npm-publish-package.mjs`](#scriptscinpm-publish-packagemjs)
- [Release fan-out](#release-fan-out)
  - [Containers reuse what the fan-out already built](#containers-reuse-what-the-fan-out-already-built)
  - [Multi-arch images](#multi-arch-images)
  - [Draft-first releases](#draft-first-releases)
  - [Package managers publish last](#package-managers-publish-last)
  - [Prerelease routing](#prerelease-routing)
  - [Build provenance](#build-provenance)
    - [Testing it without cutting a release](#testing-it-without-cutting-a-release)
- [Actions cache budget](#actions-cache-budget)
  - [Why the Docker build cache is not in this budget](#why-the-docker-build-cache-is-not-in-this-budget)
- [Secrets](#secrets)
- [Reproducing CI locally](#reproducing-ci-locally)
- [Gotchas](#gotchas)

<!-- END doctoc -->

## The workflows at a glance

| Workflow | Trigger | Red build blocks a release? | Purpose |
| --- | --- | --- | --- |
| `ci.yml` | PR, push to `main`, `v*` tags, manual | **Yes** | Build, lint, test, deploy the webapp |
| `pull-request.yml` | PR (open/reopen/sync/edit), PR comment | **Yes** | The required `CLA Signed` and `PR Title Lint` checks |
| `codeql.yml` | source push to `main`, weekly, manual | No | Static analysis into the Security tab |
| `coverage.yml` | weekly Sunday 06:43 UTC, manual | No | Rust + React coverage reports |
| `parity.yml` | nightly 07:13 UTC, manual | No | Byte parity against live chdman / dolphin-tool, with an exact cached CLI |
| `e2e-nightly.yml` | manual | No | Exhaustive browser E2E, service-worker checks, and published-install smoke tests |
| `cache-cleanup.yml` | every 6 h, manual | No | Reap closed-PR and superseded Actions caches |
| `cloudflare-preview-cleanup.yml` | every 6 h, manual | No | Reap stale Cloudflare Pages preview deployments |
| `release.yml` | manual, release PR merge | n/a | Release Please, then the publish fan-out |
| `cargo-publish.yml` | `v*` tag push, manual | n/a | crates.io publish |
| `npm-publish.yml` | called by `release.yml` | n/a | 9 platform packages, launcher, alias |
| `docker-publish.yml` | called by `release.yml`, manual | n/a | CLI + webapp images to ghcr.io (the `latest`/`beta` channels; `nightly` is pushed from `ci.yml`) |
| `attestation-dry-run.yml` | manual | No | Prove the release attest steps and both installers' checks without cutting a release |

`pull-request.yml` holds the two gates a **contributor** rather than the code has
to clear: the CLA signature (`CLA Check` job) and a Conventional Commits pull
request title (`Title Check` job), under the `PR Gates` workflow. They share a file because they share every
constraint - each posts a commit status against the pull request head instead of
relying on its own check run, each keeps exactly one marker comment on the
thread, each has to work for a pull request from a fork, and each is required by
the `main protection` ruleset. Both run on `pull_request_target`, which is what
supplies a write token on a fork's pull request; nothing from the head is
checked out or executed, and the scripts, the allowlist and the commitlint
config all come from the base commit.

| Script | Test | Posts |
| --- | --- | --- |
| `scripts/ci/cla-gate.mjs` | `cla-gate.test.mjs` | `CLA Signed` |
| `scripts/ci/pr-title-gate.mjs` | `pr-title-gate.test.mjs` | `PR Title Lint` |
| `scripts/ci/github-api.mjs` | (exercised by both) | - |
| `scripts/ci/commitlint-report.mjs` | (exercised by the title gate's step) | - |

Both tests drive the script against a stub GitHub API served over real HTTP, so
the JSON, base64 and status handling runs rather than a mock of it.

The CLA gate checks every contributor to a pull request against
[CLA version 2.0](../../CLA.md), whose grant covers every repository in the
`rom-weaver` organization rather than this one alone.

| Where | What |
| --- | --- |
| `.github/cla-allowlist.txt` (default branch) | Logins exempt from signing, one glob per line. `*[bot]` covers every bot; brackets are literal, and an unescaped `*[bot]` would be a character class matching anything ending in b, o or t. |
| `cla-signatures` branch, `signatures.json` | The signature records. It lives off the default branch because the `main protection` ruleset forbids direct pushes and names no bypass actor, so a workflow cannot commit there. |

Each record carries `claVersion` and a `cla` link pinned to the commit the gate
read the document at, because section 6 promises a signature names the version
it was given against. A `blob/main` link would repoint every past record at the
next version. `CLA_REF` supplies that commit, resolved with `git rev-parse HEAD`
in the workflow rather than from the event payload - on `issue_comment`, which
is the signing path, the checkout ref is the branch name `main`. Every other
path is env-driven too (`CLA_FILE`, `CLA_DOCUMENT`, `SIGNATURES_BRANCH`,
`SIGNATURES_PATH`, `ALLOWLIST_FILE`), so pointing the gate at an
organization-level document and signature store later needs no code change -
only a token that can write outside this repository.

An unsigned contributor gets a failing status and one comment - edited in place
on later runs, never duplicated - asking them to reply with the signing
phrase, offered in a fenced block so GitHub renders its copy button. That reply
is what appends their record. Matching ignores case, runs of interior
whitespace, any trailing `.` or `!`, and the `*`, `_`, `` ` `` or `-` a
contributor may wrap or bullet the line with - the leading and trailing
delimiter sets are one constant precisely so they cannot drift apart again. Not
ignored: a leading `>`, because accepting a quoted line would turn quoting the
request while asking what it means into assent.

A line that carries the phrase but is not the phrase - quoted, or with other
words around it - does not sign, and the comment now says so rather than
rejecting it in silence. That silence was the whole failure being fixed here; a
contributor who typed the words and got nothing back believes they signed.
Editing a comment reruns the gate, as does posting another, and between them
that is the whole re-run story: the near-miss note asks for a correction, and
editing the comment you just posted is the obvious way to make one. There is deliberately no `recheck` keyword. The prefilter
already matches any comment mentioning the CLA, and it cannot miss a signing
attempt - the phrase ends in "the CLA" and a near miss contains the whole phrase -
so a second keyword bought nothing an edit does not.

An edit signs only when the editor is the comment's own author: anyone with write
access can edit somebody else's comment, so `sender` and `comment.user` have to
agree before a signature is recorded.

Commits whose author email matches no GitHub account are reported as
`unlinked:<name>` rather than skipped.

The two signals mean different things, and the job deliberately exits 0 on an
unsigned verdict:

| Signal | Meaning |
| --- | --- |
| `CLA Signed` | The verdict. Everyone has signed, or somebody has not. This is the one the ruleset can require, and the only one a signing comment can flip - see below. |
| `CLA Check` job red | The gate itself broke: an API call failed, or the signature file would not parse. Never "somebody has not signed". |

Requiring the **status** rather than the job name is load-bearing. A run
triggered by `issue_comment` attaches its check run to the default branch rather
than the pull request head, so a required `CLA Check` job would never be cleared
by a contributor's signing comment - only by pushing a commit. The script posts
`CLA Signed` against the head SHA explicitly, which works on both paths. The
title gate posts `PR Title Lint` the same way, for consistency and so neither
required check depends on how GitHub attaches a `pull_request_target` check run.

The naming follows from that split. The jobs are named for the machinery and
render under the workflow (`PR Gates / CLA Check`, `PR Gates / Title Check`);
the statuses are named for the verdict and render bare in the ruleset's required
list, so they carry the context the jobs get from the prefix (`CLA Signed`,
`PR Title Lint`). Never give a job and a status the same name - the required-check
picker lists check runs and commit statuses in one flat list, so a collision can
silently bind the requirement to the check run, which is the broken half.

**This replaced the hosted CLA Assistant app** ([#129] is the case that forced
it). That app posted only in response to a `pull_request` event and offered no
re-run button anywhere, so a force-push left the new head with no status at all
and the pull request sat on "Expected - waiting for status to be reported" with
every other check green and nothing able to merge past it. Commenting `recheck`
did not help: that trigger belonged to the bot's own signature-request comment,
which never exists for an author who has already signed. Only closing and
reopening recovered it, at the cost of a full re-run of `ci.yml`. A workflow has
none of those failure modes - it fires on `synchronize` (which force-pushes
emit), reruns from the Actions tab, and always targets the current head SHA.

[#129]: https://github.com/rom-weaver/rom-weaver/pull/129

Coverage is deliberately sampled weekly rather than repeated after every green
`main` build. It restores the source-exact production WASM cache and builds on
a miss, so the report still covers the current commit; manual runs use the same
path.

The title gate lints the **pull request title only**. Merge commits are disabled
and squash merges take `PR_TITLE` as the subject, so the title is the only text
that reaches `main` and the only text Release Please reads. Branch commits are
squashed away, so they are not linted.

commitlint runs in the workflow step and hands the gate script a verdict plus a
file. That split is deliberate: routing an attacker-controlled title through
`GITHUB_OUTPUT` would let a crafted heredoc delimiter forge step outputs, and it
keeps the half worth testing free of a commitlint install.

The file is JSON, not commitlint's own paragraph. `scripts/ci/commitlint-report.mjs`
is a commitlint formatter (`--format`, passed by path so nothing has to be
installed) that writes the report out structurally - a `name`, `level` and
`message` per problem - and returns the plain text that lands in the log. The
gate branches on rule names, which is what lets the comment say something
specific instead of restating the format under every kind of failure:

| Rules | What the comment adds |
| --- | --- |
| `type-empty` | That the title has no `type:` prefix, and that this is also why `subject-empty` fired on a title that plainly has a subject. |
| `type-case`, `type-enum` | Names the type it rejected, and lists the allowed ones. |
| `header-max-length` | How many characters have to go, and no example of a shape the title already has. |

**The gate never proposes a replacement title.** commitlint hands it a rule name
and a message; it never hands over a corrected title, so any rename would be one
the gate invented - and the type is the part it cannot possibly know. Squash
merges make the title the commit subject and Release Please reads the type for
the changelog section and the version bump, so a guessed `fix:` on a feature is
not a cosmetic miss: it is a wrong bump and a wrong changelog entry, landed
silently. A rejected title costs a rename and says so out loud. Naming the rule
that broke and the types that are allowed is the whole job.

Valid types are read from `.config/commitlint.config.mjs` - the same file that
rejected the title - so the advice cannot drift from the rule. A failure that
carries no lint result at all is commitlint breaking rather than a bad title, so
the gate throws instead of posting. Editing the title reruns the gate; passing
**deletes** the comment, so a green pull request carries no gate chatter. The
title is quoted in a block quote as an inline code span, opened with a backtick
run longer than any inside it - inside a span GitHub neither links nor notifies
an `@mention`, and a shorter run cannot close it. A fence would protect the same
amount but carries a copy button and a horizontal scrollbar, which is the wrong
trade for a string you have to read whole and are about to retype. The CLA
gate's fence around the signing phrase is the opposite case, and keeps its
fence: there the copy button is the point.

Every sentence in either comment is one unbroken line. GitHub renders a single
newline inside a comment as a hard break, so prose wrapped to a column shows the
reader a line break mid-sentence - the source and the render disagree, and only
the render matters.

Nothing publishes on a push, and nothing reacts to one either. `release.yml` has
no `push` trigger: the release pull request is created and refreshed only by a
manual **Run workflow** dispatch. Merging to `main` just accumulates commits.

That is deliberate. The workflow force-pushes the release branch two or three
times per run (the release-please commit, the synced metadata, the screenshots),
and each push starts a full CI matrix on that pull request. Firing it on every
merge put 20 CI runs on the 0.8.0 release pull request, 17 of them cancelled by
the next merge, for a pull request nobody had yet decided to merge. Dispatching
by hand spends that CI once, when a release is actually wanted.

The release workflow waits for a completed successful `CI` push run for the
exact main commit before it creates or refreshes the release pull request. The
screenshots reuse that run's `wasm-prod` artifact when changed-path
classification produced one; otherwise the job rebuilds WASM from source
(~6.5 min). Merging the release pull request is what sets `release_created` and
unlocks the publish jobs.

> **`main` is protected by the active `main protection` ruleset.** Pull requests
> must use squash merge and pass `Rust`, `Webapp`, `Plumbing`, `PR Title Lint`,
> and `CLA Signed`. The ruleset has no bypass actors, so a status that is never
> reported blocks the merge outright - which is why every required name belongs
> to an aggregate job that always runs, and never to a job that path
> classification can skip or drop from a matrix, and why `CLA Signed` comes from
> a workflow that can be rerun rather than an app that cannot.

## `ci.yml` - the required gate

```text
changes ── changed paths -> rust / webapp / wasm_runtime / security / repo_lint / docker legs

             ┌── rust-host ─────┐
changes ─────┼── rust-macos ────┼── rust (aggregate check name)
             ├── rust-windows ──┤   (macOS/Windows on main, not PRs)
             └── cli-platforms ─┘   (9 release targets; 1 on a pull request)

         ┌── webapp-static ───────┐
         ├── webapp-browser ──────┼── webapp (aggregate check name)
         │   (2 shards)           │
         ├── webapp-wasm-browser ─┤ (runtime inputs only)
         ├── webapp-e2e ──────────┤
         ├── webapp-webkit-e2e ───┘
wasm ────┤
         └── deploy ── Cloudflare Pages, one leg per channel (non-gating)
                 ↑
           deploy-plan ── ref -> channel list
                 └── deploy-preview-fast ── preview, wasm cache hit only
                                            (skips deploy's preview leg)

             ┌── repo-lint ───────────┐
changes ─────┼── docker (0-4 legs) ───┼── plumbing (aggregate check name)
             ├── wasm ────────────────┤
             └── docker-prebuilt ─────┘ (via webapp-static: the release COPY path;
                                          PRs need an image-side change)
                    │      │
                    │      └── docker-prebuilt-nightly ┐ manifest list + attest
                    └───────── docker-nightly ─────────┘ (main pushes only)

security ── advisories (warn only, always green)
```

### Jobs

- **`changes`** classifies the pull request or push diff once. Rust and
  vendored C changes select Rust, webapp integration, and the direct WASM
  browser suite -
  except Rust test, bench, and example sources, which select the Rust jobs
  alone because they enter neither the WASM module nor the release binary;
  browser runtime/worker/storage changes additionally select that direct WASM
  suite, while UI-only changes do not. Webapp-only changes restore the exact
  cached WASM module; dependency manifests select the advisory scanners;
  workflows, composite actions, shell scripts, Dockerfiles, and Markdown select
  the plumbing lint.
  Documentation changes select only that lint stack, not the expensive compiled
  stacks. Manual runs and changes to
  CI, coverage, the toolchain, or the classifier run everything. It also plans
  the `docker` matrix, because a matrix can only be fed by an upstream job's
  output.
- **`repo-lint`** lints the repository's own plumbing: `actionlint` over the
  workflows and composite actions, `shellcheck` over every tracked `.sh`,
  `hadolint` over the Dockerfiles, and `markdownlint-cli2` over owned Markdown.
  It lints every tracked file of those kinds rather than the diff, so it is
  selected by whether anything of those kinds changed at all - workflows,
  composite actions, `.github` YAML at any depth, any `*.md`, any `*.sh`, any
  `*.mjs`, any Dockerfile, `.config/hadolint.yaml` - not per file. It installs
  the pinned Node dependencies, no other language toolchain, and
  compiles nothing, so it reports in well under a minute instead of hiding
  behind a build job. `actionlint` shells out to `shellcheck` for `run:`
  blocks, which is why both are in its `tools:` list.
- **`docker`** builds the CLI and webapp images **from source**, so a broken
  Dockerfile fails here rather than at the moment it
  blocks a release publish. A pull request selects the CLI leg for its
  Dockerfile, Cargo manifests, toolchain configuration, and shared image
  plumbing - not for an ordinary `.rs` edit that the Linux release-package leg
  already compiles. A production Rust push to `main` selects it again so the
  nightly CLI image still tracks every binary change. An unselected leg is
  absent from the matrix entirely rather than starting a runner to skip its own
  steps, which is why the required check name is the `plumbing` aggregate and
  not the legs.
  Each selected image expands to one leg per architecture - amd64 on
  `ubuntu-24.04`, arm64 on `ubuntu-24.04-arm` - so nothing here runs under
  emulation; see [Multi-arch images](#multi-arch-images).
  On a **pull request** the two architectures are selected separately: editing an
  image definition (its Dockerfile, `.dockerignore`, `docker-compose.yml`,
  `docker-publish.yml`, or a shared Docker action) builds both, while a change to
  an image's compile inputs alone - a lock bump, an arch-neutral runtime config -
  builds amd64 and stops there. Whatever an architecture can break on its own
  lives in the image definition: the webapp image's arm64 WASI SDK and binaryen
  checksums, the per-arch cache ref, the exporter. The second leg is otherwise a
  second full release compile of the same source, and it cannot fail for a reason
  the first one did not. Every other event - a push to `main`, whose legs feed the
  `nightly` manifest lists, and a manual dispatch - builds both architectures of
  whatever it selected at all.
  The webapp source leg runs only when its
  image plumbing changes (the Dockerfile, `.dockerignore`,
  `docker-compose.yml`, `sws.toml`, the Docker compression script, `ci.yml`,
  `docker-publish.yml`, or either shared Docker action); ordinary webapp changes
  use the release-equivalent
  prebuilt smoke below. On `main`, source builds also refresh their registry
  cache, and the **CLI legs push `ghcr.io/rom-weaver/rom-weaver-cli:nightly`**
  - the image half of the nightly deploy channel - by digest, for
  `docker-nightly` to tag. A pull request never pushes,
  because a fork's token cannot write to the registry. The webapp leg does not
  publish: it compiles its own wasm, so its bundle is not the one
  nightly.rom-weaver.com serves; that image comes from `docker-prebuilt` below.
  The CLI leg additionally smokes the `BINARY=prebuilt` release path
  with a stub binary whenever it is selected.

  `DIST=prebuilt` is not the way to lift the cost here: it skips the entire
  builder stage (rustup, the pinned WASI SDK and binaryen checksums, `npm ci`,
  the wasm compile), which is exactly the fragile half this job exists to test.
  The CLI image has no wasm in it at all - it is `cargo build --release -p
  rom-weaver-cli`, and CI publishes no Linux release binary to reuse.

  The webapp leg does reuse the **wasm module**, which is a narrower thing. It
  restores the same source-exact cache the `wasm` job uses (read-only - it never
  builds the module, so claiming the key on a miss would deny it to the job that
  does) and on a hit passes `WASM=prebuilt`, which takes the module out of the
  build context instead of compiling a second identical copy. That compile was
  ~390s of the job's ~570s, and the job was the whole tail of an uncontended
  run. Everything else still builds from source, the toolchain layers still
  verify this architecture's WASI SDK and binaryen checksums, and a miss simply
  compiles as before.

  **amd64 only.** The arm64 leg always compiles from source, so every run still
  drives the full Dockerfile path rather than leaving it to whoever next edits
  the image. There is deliberately no `needs: wasm` edge - the `docker` matrix
  carries the CLI legs too, and they want nothing from wasm; an edge would queue
  them behind a six-minute build. `WASM=prebuilt` refuses to build if the module
  is not actually staged, so a mis-wired caller fails loudly instead of shipping
  whatever `COPY . .` happened to carry.
- **`docker-prebuilt`** builds the webapp's `DIST=prebuilt` release path. It
  consumes the real `webapp-dist` artifact `webapp-static` uploads, so
  `compress-static-assets.mjs` runs over the real bundle. That is also why the
  webapp's nightly image is published here and not from the `docker` leg: this
  job wraps the exact artifact `deploy` ships to nightly.rom-weaver.com, so the
  image and the site are the same bundle. On `main` it pushes
  `ghcr.io/rom-weaver/rom-weaver-webapp:nightly`. The CLI equivalent
  stays in the image-gated `docker` leg instead of starting a separate prebuilt
  runner. Pull requests build amd64 only to prove the release COPY/compression
  path; `main` builds amd64 and arm64 for the nightly manifest.
  The two refs also gate it differently, because the job means a different thing
  on each. It runs no builder stage - it copies `webapp-static`'s artifact into
  the image - so on a pull request it can only fail for an image reason, and it
  needs one: the same image-plumbing selection the webapp source leg takes. A
  Rust or UI change that rebuilds the bundle and touches no image file skips it.
  On `main` the webapp stack alone selects it, because there it is not a smoke
  test but the sole publisher of the webapp `nightly` image, and every new bundle
  owes that channel one. The bundle is
  architecture-independent, but the image around it is not (a Node.js
  compression stage, an Alpine runtime).
- **`docker-nightly`** and **`docker-prebuilt-nightly`** run on `main` pushes
  only. The build legs above push tagless digests; these join each image's two
  digests into the manifest list that actually claims `:nightly`, then attest
  that list. See [Multi-arch images](#multi-arch-images).
- **`wasm`** builds the production WASM module. This is the single most
  expensive step in the pipeline (~6.5 min) and it used to run twice, so it is
  built once here and shared with `webapp` and `deploy` as an artifact, and
  with `release` by artifact download. A webapp-only change
  restores it by its source-exact key; a change outside the webapp/runtime
  stack skips the job outright, along with everything downstream that would
  have consumed the artifact.
- **`rust-host`** is everything needing a host-profile Rust build: fmt, clippy,
  typegen drift, whitespace, thread guards, the Rust test suite, license
  attribution, `cargo deny` licenses/sources, unused dependencies, and a
  `cargo publish --dry-run`.
- **`cli-platforms`** builds and packages the native release targets before
  release day: macOS arm64/x86-64; Linux x86-64 GNU plus arm64/i686/x86-64
  musl; and Windows arm64/x86/x86-64 MSVC. Every binary verifies a SHA-256;
  round-trips ZIP, 7z, and Z3DS; extracts fixed CHD, RVZ, TAR, and RAR fixtures;
  and creates/applies fourteen patch formats on its target architecture. Native
  arm64 runners and OS emulation cover the 32-bit x86 targets. The matrix runs
  only when Rust or native-package inputs change. **Pull requests build only
  `linux-x64-gnu`** - the entry marked `pr` in
  ([`.github/cli-platforms.json`](#githubcli-platformsjson)). Pushes to `main`
  and manual dispatches still build all nine, run the native arm64 artifact,
  and every main commit is a release candidate, so full coverage always lands
  before a release. Both the target list
  ([`.github/cli-platforms.json`](#githubcli-platformsjson)) and the build
  itself ([`.github/actions/build-cli-platform`](#githubactionsbuild-cli-platform))
  are shared with the release fan-out, so this job cannot cover a different set
  of targets - or build them differently - than the one that ships.
- There is **no separate `wasm-check` job**. It ran `cargo check -p
  rom-weaver-containers --lib` against `wasm32-wasip1-threads`, which `wasm`
  already compiles as a strict subset (the app build pulls `containers` in with
  default features), and whose cache key covers every input that could break
  it - so a cache hit means nothing checkable changed. The check remains part
  of the broad local `mise run ci` gate.
- **`rust-macos`** runs the Rust test suite on `macos-15` (arm64) after merge
  to `main` (and on manual runs) - the
  platform the release fan-out ships CLI binaries for, but that nothing
  previously tested. The fan-out builds the shipped `darwin-arm64` binary on a
  newer image than this leg tests on (`.github/cli-platforms.json`); what keeps
  the shipped minimum below both is `MACOSX_DEPLOYMENT_TARGET`, not the runner
  version - see [macOS support floor](#macos-support-floor). It uses the same
  mise/setup-build-env path as the Linux jobs. fmt, clippy, typegen, and the
  policy checks are platform-independent and already gate in `rust-host`.
- **`rust-windows`** runs the Rust test suite on `windows-2025` after merge to
  `main` (and on manual runs). It installs
  the toolchain with `dtolnay/rust-toolchain` (pin read from `.config/mise.toml`)
  rather than mise, whose `[env]` exec templates assume a POSIX shell; the
  release jobs already prove this route on the same image. Because it bypasses
  mise it re-declares `CARGO_INCREMENTAL=0` itself, and it trims MSVC debug
  info to line tables (`CARGO_PROFILE_DEV_DEBUG=line-tables-only`) - PDB
  generation is the priciest part of a Windows debug build. No wasm leg:
  building the wasm module on Windows is unsupported until the bash compiler
  shims have a native counterpart.

  The test run phase uses cargo-nextest on every platform leg (the mise legs
  through the `test-rust` task, Windows via `taiki-e/install-action` at the
  same pinned version). nextest does not execute doctests, so each leg runs a
  separate `cargo test --doc` pass rather than silently shrinking the suite.
- **`plumbing`** is an aggregator over `repo-lint`, `docker`,
  `docker-prebuilt`, and `wasm`, on the same `scripts/ci/assert-jobs.mjs` as
  `rust` below - one call per selection flag, because those jobs do not share
  one. `docker-prebuilt` has a flag of its own (`docker_prebuilt`) rather than
  riding the webapp flag beside `wasm`: a pull request skips it for a webapp
  change that touched no image file, which the webapp flag would report as a
  missing job. All four are skippable, and a matrix leg that is not planned reports no
  status at all, so `Plumbing` is the only name branch protection can safely
  require for them.
- **`rust`** is an aggregator: it fails unless selected jobs succeeded and
  unselected jobs were intentionally skipped. It also fails if classification
  itself failed.
  Its only purpose is to present one stable check name (`Rust`) while the work
  runs in parallel, so branch protection has a single thing to require.
- **`security`** runs on dependency-manifest changes and executes `cargo deny
  advisories` and `npm audit`. **Deliberately
  non-gating** - an advisory can be published against a transitive dependency
  without any commit of ours, and letting that turn every open pull request red
  blocks unrelated work. Findings surface as warnings via
  `scripts/warn-only.mjs`; the job stays green.
- **`webapp-static`**, **`webapp-browser`**, **`webapp-wasm-browser`**,
  **`webapp-e2e`**, and **`webapp-webkit-e2e`** consume the prebuilt module and
  compile no Rust. Independent suites run in parallel: `webapp-static` is the
  node-only work (build script tests, lint, unit tests, vite build, performance
  budgets; no Playwright install), `webapp-browser` is the two-shard browser
  suite and uses Chrome from the Ubuntu runner image, `webapp-wasm-browser` is
  the direct WASM/browser contract selected only for conservative runtime
  inputs, and `webapp-e2e` runs the channel-icon check plus Chromium journeys.
  The WebKit leg runs the
  supported Safari-family implementation on macOS. It must stay on `macos-15`
  or newer: Playwright freezes WebKit at revision 2251 on `mac14`/`mac14-arm64`
  via `revisionOverrides`, so that build no longer gains the protocol settings
  newer clients send and every launch fails on an unknown setting.
  `webapp-browser` is itself a two-shard matrix
  (`BROWSER_TEST_SHARD=<i>/2`). The runner script already gives every test file
  its own Vitest process and caps concurrency at `min(4, cores)`, which
  saturates a 4-core runner, so halving that leg required a second machine
  rather than more local parallelism. Files are packed largest-first onto the
  lighter shard - their sizes, and runtimes, are very uneven. A matrix
  dependency reports one combined result, so the `webapp` aggregate needs no
  change: any failing shard fails the check.
- **`webapp`** is the aggregator for those jobs, mirroring `rust`: one stable
  check name (`Webapp`) while the suites run in parallel.
- **`deploy-plan`** turns the ref into the list of channels to publish (below).
  It exists as its own job because a matrix can only be fed by an upstream
  job's output. Documentation-only commits do not deploy; webapp/runtime
  changes, tags, and explicit manual deploys do.
- **`deploy`** ships the site, one matrix leg per channel (below). Both jobs
  are `continue-on-error: true`, so a Cloudflare outage cannot turn a green
  `main` red and suppress release automation.
- **`deploy-preview-fast`** publishes the PR preview without waiting on `wasm`.
  `deploy` needs that job's artifact; this one restores the same module from
  cache, which hits on every PR that leaves `Cargo.lock` and `crates/` alone
  and lands the preview URL ~13s sooner. On a miss it deploys nothing - never
  the module itself, which would duplicate the ~6.5 min build already running -
  and `deploy` publishes the preview as usual. The two can never both publish:
  `deploy` skips whenever this job reports a URL. Both share
  `.github/actions/deploy-webapp-pages` so a preview has exactly one build-and-
  publish implementation.

### Performance budgets

`webapp-static` runs the freshly built production bundle through the checked-in
budgets in `packages/rom-weaver-webapp/performance-budgets.json`
(`npm run test:performance`). Crossing an `expected` value emits a warning
annotation; crossing the wider `maximum`/`minimum` fails the required `Webapp`
check. Sizes are bytes, Lighthouse scores are 0-1, timings are milliseconds.
The two halves run with `run-s --continue-on-error`, so a size failure still
reports the Lighthouse table rather than hiding it.

The Chromium webapp E2E pass reuses its live axe-core crawl to collect CSS
coverage from the served production bundle. It visits the not-found page,
Settings, every workflow, candidate selection, reset confirmation, the log
dialog, an info popover, a codec menu, patch editing and reordering, and every
guided Apply/Create step in both themes at desktop and mobile sizes. It unions
the observed rules and fails when unused external stylesheet bytes exceed the
`cssCoverage` budget. The budget is a regression ceiling, not a claim that
unobserved rules are dead: progress, result, error, pointer-drag, update, and
other conditional states can legitimately remain outside that crawl.
Duplicate declarations are covered by Biome's recommended CSS rules, and
duplicate selectors are enabled explicitly.

`check-size-budget.mjs` measures raw bytes plus the bundled `.br` sidecar where
one exists. The hashed `/assets/*` entries all have one; the HTML shell does
not - root files deliberately stay off the sidecar path - so its Brotli column
is an estimate compressed at `assetSizes.brotliQuality`, and moves with that
setting rather than with anything shipped.

Lighthouse always audits the local build through `scripts/dev-server.mjs
preview`, using Lighthouse's default mobile emulation, on every event, including
forks. A Lighthouse runtime collection error gets one fresh-browser retry;
threshold failures are never retried. The server speaks HTTP/2, serves the q11
sidecars, applies the built `dist/_headers`, and holds each asset in memory after
the first read, which is what
makes it a fair stand-in for the edge - measured against the hosted Cloudflare
bundle it scores slightly *better*, because HTTP/1.1's ~6-connection cap was the
only thing that had made a local audit look slow. Auditing the deployed preview
instead would gate a required check on `deploy-preview-fast`, which is
`continue-on-error: true` precisely so a Cloudflare outage cannot redden a
build, and which is not ordered ahead of this job anyway.

Applying `dist/_headers` is what puts the `Link:` preload hints in front of the
audit, and the preview server replays them in a real `103` ahead of each HTML
response the way the edge does - without that, Lighthouse would grade a
discovery path for the render-critical CSS and entry module that production does
not have. `scripts/pages-headers.mjs` parses the file; documents get the `103`,
subresources do not, since a subresource ignores the hint and the extra
informational response would only add to what the audit measures.

`wrangler pages dev` is the closer emulator for everything else - it runs
`_routes.json` and the sidecar Function for real - but it cannot serve this gate:
Early Hints is a zone-level CDN feature rather than part of the Pages runtime, so
wrangler never emits a `103`, and it speaks HTTP/1.1 only, which reintroduces
exactly the ~6-connection cap this server exists to avoid. It is the right tool
for checking `_headers`/`_routes.json`/Function behaviour by hand, just not for
timing.

Both tables land in the job summary, and all three runs per route are
downloadable as HTML and JSON from the 14-day `lighthouse-reports` artifact,
including on a gate failure. Same-repository pull requests additionally get a
`Lighthouse report` commit status pointing at a no-index Cloudflare Pages index
of those runs, published to the `lighthouse-pr-<number>` branch of the
`rom-weaver-preview` project and reaped by `cloudflare-preview-cleanup.yml` on
the same terms as the preview itself. Fork pull requests stop at the artifact
link, because their read-only token can neither deploy nor publish a status.

Reproduce a CI run with a production WASM artifact, a rebuild, then the gates:
`mise run build-wasm-prod`,
`npm --prefix packages/rom-weaver-webapp run build`, and
`npm --prefix packages/rom-weaver-webapp run test:performance`. The audit picks
a free port unless `PORT` is set.

### Tag runs

Release tags (`v*`) trigger this workflow, but every test job carries
`if: github.ref_type != 'tag'`. The commit being tagged already passed the same
gate on `main`; a tag run exists only to build and deploy the webapp to the
channels that tag publishes.

### Deploy channels

`deploy-plan` resolves the channel list from the ref; `deploy` runs one matrix
leg per channel, deploying with Cloudflare Direct Upload and reusing the
CI-tested WASM artifact rather than spending Cloudflare build minutes on a
second toolchain.

| Channel | Cloudflare project | URL | Intended use |
| --- | --- | --- | --- |
| `prod` | `rom-weaver` | [rom-weaver.com](https://rom-weaver.com/) | Stable public webapp |
| `beta` | `rom-weaver-beta` | [beta.rom-weaver.com](https://beta.rom-weaver.com/) | Release candidates and prereleases |
| `nightly` | `rom-weaver-nightly` | [nightly.rom-weaver.com](https://nightly.rom-weaver.com/) | Latest webapp changes from `main` |
| `preview` | `rom-weaver-preview` | `pr-<n>.rom-weaver-preview.pages.dev` | Review an internal pull request |

Only production is intended for search indexing. Beta, nightly, and pull-request
preview builds include `noindex, nofollow` in both the HTML robots metadata and
the Cloudflare `X-Robots-Tag` response header, and their generated `robots.txt`
blocks crawling with `Disallow: /`. Production instead publishes `Allow: /`.
Its sitemap lists the two stable, crawlable workflow pages:
[`/apply`](https://rom-weaver.com/apply) and
[`/create`](https://rom-weaver.com/create). History API navigation keeps those
URLs distinct; the generated HTML gives each its own title, description, and
canonical URL plus Open Graph and Twitter card metadata.

The apex is the one canonical origin. `www` is a separate origin, so serving the
app there would give it its own OPFS store and service worker and a user landing
on it would see different saved state. The redirect that prevents this is a
zone-level Single Redirect in the Cloudflare dashboard (rom-weaver.com -> Rules
-> Redirect Rules, "www to apex"), not the build's `_redirects` - that file
matches a path and never a hostname, and Cloudflare lists domain-level redirects
as unsupported, so a rule written there is dropped silently. One was, from
v0.7.2 through v0.9.0, and www served the app on its own origin for all three
releases. Because the rule lives in the dashboard, nothing in this repository
gates it; the `www` DNS record has to stay proxied for the rule to see the
request at all.

Each build also generates Cloudflare Pages `_headers`. All channels receive the
cross-origin isolation headers required by threaded WASM. Content-hashed
`/assets/*` responses use a one-year immutable browser cache, while
`cache-service-worker.js` uses `no-cache` so a deployment is discovered
promptly. The `Content-Signal` header permits agent input on every channel,
permits search use only on production, and declines AI training. Non-production
channels add their `X-Robots-Tag` in the same file.

Every response also carries `Link:` preload headers for the two
render-critical subresources - the stylesheet and the entry module. Neither is
discoverable until the document has been fetched and parsed, so Cloudflare
replays them in a `103 Early Hints` response and both fetches start during
server think time; browsers that ignore `103` still act on the header when the
document response lands, which is earlier than the parser either way. They ride
in the `/*` block rather than an enumerated route list, so every prerendered
route, every docs slug, and any route added later is covered without upkeep;
subresource responses carry the header too and ignore it. Both use `rel=preload`
(`as=style` and `as=script`) rather than `rel=modulepreload` for the entry:
Cloudflare only replays `preload` and `preconnect` in the `103`, so a
`modulepreload` line still works on the document response but is dropped from
the Early Hints, which is the half worth having. Chrome starts the entry fetch
from the `as=script` hint and the module script reuses it, so nothing
double-fetches. The hinted URLs are read back out of the built `index.html` by
`packages/rom-weaver-webapp/scripts/critical-asset-hints.mjs`, which the build
and `scripts/verify-seo-build.mjs` share so the emitted header and the check
guarding it cannot drift; the verifier fails the build if either drifts from the
URL the document actually requests.

Pages has no precompressed-sibling convention and recompresses assets on the
fly at a lower quality than the build's quality-11 brotli pass (~640 KB worse
on the wasm and ~50 KB on the main JS bundle, per cold load). Every webapp
build therefore stages the prebuilt `.wasm.br` sidecar next to the hashed
wasm asset (or generates it when only a development WASM artifact is
available), compresses every other `/assets/*` file to a q11 sibling kept
only when it saves at least 2% (already-compressed formats such as woff2/png
fail that bar and stay static), and writes a `_routes.json` routing exactly
the sidecar-backed URLs through the Pages Function in
`packages/rom-weaver-webapp/functions/assets/[name].js`. The function takes
the content type from `functions/assets/content-types.js` and serves the
sidecar bytes with `Content-Encoding: br`
(`encodeBody: "manual"`) to br-capable clients, falling through to static
serving otherwise; unrouted requests never invoke it. That table is the one
place the mapping lives - `writeBrotliSidecars` imports it and fails the build
if it stages a sidecar for an extension the table does not cover, so it cannot
go stale. It replaced a headers-only probe of the static asset, which was a
second subrequest the sidecar fetch had to wait behind and so put a serialized
round trip in front of the render-critical CSS and entry module. Because function
responses bypass `_headers`, the function restates the immutable cache rule
and the cross-origin-isolation headers - COEP in particular, which
dedicated-worker scripts must carry on a cross-origin-isolated page. Only
`/assets/*` is eligible: the mutable root files (`index.html`,
`cache-service-worker.js`, `changelog.json`) keep their no-cache semantics
and never route through the function. Release archives, Docker images,
Cloudflare deployments, and local production previews now consume the same
hashed-asset sidecars, which is also what lets the preview server stand in for
the edge in the performance budgets above. Two consequences of staging them
everywhere rather than on deploys only: the release tarball carries the `.br`
siblings (~2 MB, and no longer asserts their absence), and every bundle ships a
`_routes.json` that only Cloudflare reads - inert but public wherever the
bundle is self-hosted.

Production bundles carry external source maps (`build.sourcemap`), so a stack
trace from a deployed build resolves to real source. They are the one class of
asset that stays out of all three compression/caching paths: no q11 sidecar and
no `_routes.json` include, no `compress-static-assets.mjs` pass in the Docker
image, and no service-worker precache entry. Nothing but devtools ever requests
them, so a normal visit pays only for the `sourceMappingURL` comments (~0.8 KB
raw across the bundle). The maps themselves add ~5.7 MB to the release tarball
and the image.

Quality 11 on the wasm costs ~15s, which every build would otherwise repay for
an unchanged asset, so `scripts/wasm/brotli-compress.mjs` keys its output by
input digest and brotli parameters under `node_modules/.cache/rom-weaver-brotli`
and verifies a hit by decompressing it before reuse. Entries unused for 14 days
are pruned; `ROM_WEAVER_BROTLI_CACHE=0` disables the cache.

Cost model: sidecar-backed URLs invoke the function, everything else stays
on the unmetered static path, and repeat visits are covered by the immutable
browser/service-worker cache. To keep invocations from scaling with traffic,
the nightly deploy leg idempotently installs a zone Cache Rule ("Ensure zone
cache rule for /assets" in `ci.yml`) making `/assets/*` on the prod, beta,
and nightly custom domains eligible for edge caching with `respect_origin`
TTLs - the function then runs roughly once per URL per PoP instead of per
request. Safe because every routed URL is content-hashed and immutable. The
step skips with a notice until two pieces of one-time setup exist: a
`CLOUDFLARE_ZONE_ID`
repository secret (the `rom-weaver.com` zone) and `Zone -> Cache Rules ->
Edit` added to the `CLOUDFLARE_API_TOKEN`. `pages.dev` previews sit outside
the zone, so preview traffic stays per-request - fine, it is internal. A
`caches.default` lookup inside the function would not reduce the bill (the
invocation is counted whether or not it hits cache). Free tier:
100,000 invocations/day; past it, the flat $5/month Workers Paid plan; on
free, excess requests degrade gracefully to static serving (Cloudflare's own
recompression) for the rest of the day. After first enabling the rule,
verify encoding negotiation once: a client without `Accept-Encoding: br`
must still receive usable bytes from an edge-cached URL (Cloudflare
transcodes stored representations per client, but confirm rather than
trust).

The channels form a stability ladder - `prod` above `beta` above `nightly` -
and a ref deploys to the channel it enters at **plus every less-stable channel
below it**. Otherwise a quiet stretch on `main` would leave beta and nightly
serving code older than production, which makes them useless for reproducing a
release-day bug.

| Ref | Deploys to |
| --- | --- |
| `vX.Y.Z` tag | `prod`, `beta`, `nightly` |
| `vX.Y.Z-alpha.N` tag | `beta`, `nightly` |
| webapp/runtime push to `main` | `nightly` |
| webapp/runtime pull request | `preview` |

Legs are independent Pages projects with no shared state, so they upload in
parallel and a release's three channels land in the time of one. Each leg
builds its own bundle because the channel is baked in at build time
(`ROM_WEAVER_CHANNEL`), so there is no artifact to share between them. Failure
is per-leg (`fail-fast: false`): a beta upload failing still lets prod ship.

A hyphen after the version is what makes a tag a prerelease. The same rule
routes the npm dist-tag and the docker `beta` tag - see
[prerelease routing](#prerelease-routing).

`workflow_dispatch` takes a `deploy_channel` input that deploys exactly the
channel named, with no cascade - it is a break-glass override, not a release.

Preview deployments are skipped for forks and Dependabot, which are not given
the Cloudflare secrets and could only ever fail. The preview URL reaches the
pull request through the GitHub `environment` below and through the
`Webapp Deploy / preview` commit status.

Each leg also declares a GitHub `environment` named for the hostname it serves
(`rom-weaver.com`, `beta.rom-weaver.com`, `nightly.rom-weaver.com`, and
`rom-weaver-preview.pages.dev` for previews), so wrangler's Direct Upload is
mirrored into GitHub's Deployments API - PRs get a native "View deployment"
button. Each leg also posts a `Webapp Deploy / <channel>` commit status against
the deployed commit: pending and failure link to the workflow run, while
success links to the exact Cloudflare deployment URL. The channel is one of
`prod`/`beta`/`nightly`/`preview`, so this resolves to exactly four stable
environments; all previews share
`rom-weaver-preview.pages.dev` (each PR's actual URL is
`pr-<n>.rom-weaver-preview.pages.dev`) rather than minting one per PR. They are
informational only - no protection rules or approvals, and `continue-on-error`
still keeps a Cloudflare outage from reddening the build - but leave room to
later add allowed branches/tags, approvals, wait timers, or environment-scoped
secrets. That native deployment link replaced the old marker-backed preview PR
comment, which duplicated it. After both preview paths settle, CI keeps the
newest successful deployment and the newest failed deployment for the pull
request branch, then deletes inactive objects and older failures. This
preserves the current preview plus the latest failure for diagnosis while
removing superseded "temporarily deployed" and failed timeline entries; cleanup
failure is informational and cannot fail the build. The cleanup lives in
`scripts/ci/cleanup-preview-deployments.sh` and is covered by the repository's
shellcheck gate.

The preview project is swept every six hours. The cleanup keeps the newest
deployment for each open PR and gives superseded deployments a seven-day grace
period; deployments belonging to closed or merged PRs are deleted after that
grace period. The scheduled sweep also handles orphaned deployments when no
close-triggered workflow can run.

Projects are created on demand through the Cloudflare REST API rather than
`wrangler pages project create`: wrangler enumerates accounts internally, which
a token scoped to specific account resources cannot do, and reports the failure
as a bare `unknown error [code: 8000000]`.

## Shared building blocks

Duplicated CI logic lives in one place. Changing one of these changes every
consumer, which is the point.

### `.github/actions/setup-build-env`

Every toolchain concern, each opt-in so a job installs only what it runs: apt
packages, mise-pinned tools, Rust components and targets, the cargo cache, the
WASI SDK, webapp `node_modules`, and Playwright browsers.

The `tools:` input is a **positive** list of short tool names
(`tools: node rust nextest`). mise offers no allowlist - `MISE_DISABLE_TOOLS`
is the only lever - so `scripts/ci/mise-disable-tools.mjs` reads the `[tools]`
table of `.config/mise.toml` and computes the complement. Two consequences worth
knowing:

- Adding a pin to `.config/mise.toml` costs nothing until a job opts in. Under the
  old hand-maintained exclusion lists it silently slowed down every job.
- A name that is not pinned fails the job instead of being ignored.

Caching decisions that live here:

- **cargo** (`Swatinem/rust-cache`): restore everywhere, **save only on
  `main`**. A branch run writes ~450 MB into a branch-local scope nothing else
  can read, which is pure ballast against the 10 GiB budget.
- **WASI SDK**: keyed on version *and* checksum, so a version bump misses by
  construction and can never serve a stale SDK.
- **`node_modules`**: the installed tree is cached, not `~/.npm` - a hit skips
  `npm ci` outright instead of merely speeding up its download half.
- **Playwright**: browser binaries only. The apt-level libraries they link
  against are outside the cache, so a hit still runs `install-deps`. The
  parallel browser job skips this cache and uses Chrome already installed on
  the Ubuntu runner image.

### `.github/actions/wasm-cache`

Restores a prebuilt WASM module (`variant: prod` for CI and weekly coverage,
`dev` for the nightly E2E suite, which needs an unoptimized module CI never
builds). The key is a
SHA-256 over `git ls-tree` of every source, dependency, toolchain, and
build-script input - `git ls-tree` rather than `hashFiles` because it resolves
the pull request merge tree, and because the `crates` tree SHA covers the
vendored libarchive sources under it.

Deliberately no `restore-keys`: a partial-prefix hit could serve a module built
from different source. A miss costs one build; a false hit ships stale WASM.
`cache-epoch` invalidates everything by hand.

The file set is a property of the variant, not of the caller - a `dev` build
runs neither `wasm-opt` nor brotli and writes no checksum, so it has three of
the five files. Callers pass only `variant`, and the `path` output reports what
was cached so the CI job that uploads the module as an artifact cannot list a
different set than the one it restored.

### `.github/actions/build-cli-platform`

Compiles the native CLI for one entry of the platform list and stages it into
its npm platform package: toolchain, the per-platform cargo cache, the Linux
build dependencies, `cross` for the musl targets, and - for Windows - the
`vswhere` + `VsDevCmd.bat` dance that puts the right MSVC toolchain on `PATH`
for the cross-arch legs.

The Windows legs also relocate `CARGO_HOME`/`RUSTUP_HOME` to `D:` and
`TMP`/`TEMP` to `RUNNER_TEMP` before the toolchain and cache steps, for the same
IOPS reason `rust-windows` does it. The `D:` half is skipped when the runner has
no such drive; `windows-11-arm`'s disk layout is not documented.

CI and `npm-publish.yml` both use it, sharing one cache key per platform, so a
release restores what CI already built rather than compiling a second,
differently-configured copy. `cache-save` and `registry-url` are the only
things the two callers set differently.

### `.github/actions/docker-build-arch` and `docker-manifest`

The two halves of every image build in the repository. `docker-build-arch`
builds one architecture on a runner of that architecture and, when pushing,
publishes it **by digest** under no tag; `docker-manifest` collects both digests
and joins them into the manifest list that does claim the tags. `ci.yml` uses
them for the `nightly` channel and `docker-publish.yml` for everything else, so
the exporter, the per-architecture cache refs, and the digest hand-off are
defined once. See [Multi-arch images](#multi-arch-images) for why the split
exists and what it is worth.

### `.github/cli-platforms.json`

The nine released CLI targets, and the single source for all four matrices that
fan out over them - CI's build plus the fan-out's build, dry-run, and publish.
They used to be four pasted copies, which let CI quietly stop covering a target
the release still shipped.

`scripts/ci/cli-platform-matrix.mjs` emits it as a one-line matrix (a matrix can
only be fed by an upstream job's output) and documents every field, since JSON
carries no comments. Note `runner` versus `native_runner`: the first is the host
that *compiles* a target, the second the host that can *execute* the result.
They differ for `linux-arm64-musl`, which cross-builds on x64, and for both
Darwin targets, which build on the newest macOS image and are executed back on
the oldest one still offered - see below.

`pr` marks the one entry a pull request builds: `linux-x64-gnu`. The script
narrows to it only when `EVENT_NAME=pull_request`; every other caller -
including the release fan-out's `plan` job, which passes no event at all - gets
all nine.

### macOS support floor

**`rom-weaver` supports macOS 11 (Big Sur) and newer.** That floor lives in one
place: the `macos-deployment-target` input of
[`.github/actions/build-cli-platform`](#githubactionsbuild-cli-platform), which
sets `MACOSX_DEPLOYMENT_TARGET` for the Darwin builds and then reads the value
back out of the emitted Mach-O (`otool -l` → `LC_BUILD_VERSION` /
`LC_VERSION_MIN_MACOSX`). Checking `rustc --print=deployment-target` alone would
only prove what rustc intended; the floor is a property of the binary.

The build runners deliberately track the newest macOS images GitHub offers
rather than the oldest supported one. Pinning builders to old images looks like
it guarantees compatibility, but it only ever did so implicitly - and it means
inheriting each image's retirement. `macos-14`'s
([actions/runner-images#13518](https://github.com/actions/runner-images/issues/13518))
is what forced this arrangement.

Two checks keep it honest. The deployment-target assertion above runs on every
`main`, manual, and release build. Then the release fan-out's
`platform-dry-run` leg runs the full `scripts/verify-cli-platform.mjs` suite
against the exact staged artifact on every target's `native_runner` - which for
Darwin is the oldest macOS still offered - so a binary that will not run there
fails before anything is published. That gate matters more here than elsewhere:
releases are immutable, so a bad Darwin binary permanently burns the version.

Raising the floor is a user-visible change. Change the default in the action,
update this section, and say so in the release notes.

### `scripts/ci/assert-jobs.mjs`

Backs the `rust`, `webapp`, and `plumbing` aggregate checks, which present one
stable name to branch protection over a fan-out of parallel jobs. It takes one
selection flag per call, so `plumbing` - whose jobs do not share a flag - calls
it once per flag. On GitHub a skipped check
counts as passing, so the aggregate has to fail explicitly - which means telling
"skipped because the path filter said this change cannot affect it" apart from
"skipped because something upstream failed".

### `scripts/ci/classify-changes.mjs`

Maps changed paths to the Rust, webapp, direct WASM-runtime, dependency-scanning,
plumbing-lint, and per-image Docker stacks.
Rust and vendored C imply webapp integration, while webapp-only
changes do not imply Rust. Rust test, bench, and example trees are the one
exception: they select the Rust jobs but not the webapp or CLI-image stacks,
because they enter neither the production WASM module nor the release binary -
`.github/actions/wasm-cache` excludes the identical list from its cache key, so
selecting the webapp there could only ever buy a guaranteed cache hit followed
by browser jobs that cannot observe the edit. The narrower `wasm_runtime` flag
selects direct WASM browser tests for production Rust; the webapp's runtime,
platform, worker, storage, and shared type layers; dependencies; the
suite's fixtures/config; and all fail-open CI/toolchain inputs. Ordinary Rust
sources select CLI source Docker after merge, while Docker/Cargo/toolchain
inputs select it on a pull request too.

Three of its outputs exist to keep a Docker job from running for a change it
cannot report on. `docker_cli_arm64` and `docker_webapp_arm64` select each
image's second architecture separately, so a pull request that changed only an
image's compile inputs pays one release compile instead of two; editing an image
definition, and every event other than a pull request, still selects both.
`docker_prebuilt` gates the webapp prebuilt smoke, which needs a bundle on any
ref and an image-side change as well on a pull request - see
[`docker-prebuilt`](#jobs).

Changes to CI, coverage, toolchain setup, or the
classifier fail open by selecting every stack. So does the event name: only
`pull_request` narrows anything, so an absent `EVENT_NAME` costs time rather
than coverage - the same default, for the same reason, as
`scripts/ci/cli-platform-matrix.mjs`.

Two tests pin it. `scripts/ci/classify-changes.test.mjs` covers the path
boundaries and the event default.
`scripts/ci/wasm-runtime-coverage.test.mjs` covers the one boundary a path list
cannot state honestly: it walks the imports and
`new URL(..., import.meta.url)` references reachable from
`packages/rom-weaver-webapp/tests/wasm/*.test.mjs` and fails if anything the
suite can observe - including the Rust fixture trees it reads directly - does
not select `wasm_runtime`. Without it, one new import out of `src/wasm/` into an
unlisted directory silently drops the suite from that directory's changes.

### `scripts/ci/resolve-wasm-run.mjs`

Finds the CI run that built `wasm-prod` for a commit, so release packaging ships
the exact module CI tested. It accepts an optional `PREFERRED_RUN_ID` hint and
**verifies that run is actually for this commit** before trusting it, otherwise
searches by commit, and finally confirms the artifact has not expired. Release
falls back to a source build when it is unavailable.

### `scripts/ci/npm-publish-package.mjs`

Publishes one package idempotently. Eleven packages go out per release through
three jobs that all need the same three rules: never fail because the version
is already on the registry, route prereleases to the `beta` dist-tag, and treat
"publish failed but the version is now present" as a concurrent run winning the
race rather than an error.

The prerelease test reads the **version**, never the package spec - platform
package names contain hyphens (`@rom-weaver/cli-darwin-arm64`), so matching the
spec would tag every platform package as a prerelease.

## Release fan-out

`release.yml` runs Release Please, then on `release_created`:

| Job | Produces |
| --- | --- |
| `semver-check` | nothing - gates the publish on no accidental breaking API change |
| `cargo-publish-dry-run` | nothing - gates npm and draft publication on crates.io accepting Cargo metadata |
| `static-webapp` | `rom-weaver-webapp.tar.gz` + checksum on the GitHub release |
| `publish-npm` | 9 platform packages → launcher → unscoped alias, in that order |
| `publish-containers` | `ghcr.io/rom-weaver/rom-weaver-cli` and `-webapp`, signed provenance |
| `publish-release` | flips the draft release to published, creating the tag |
| `publish-homebrew` | formula commit to `rom-weaver/homebrew-tap` (stable only) |
| `publish-scoop` | manifest commit to `rom-weaver/scoop-bucket` (stable only) |

The table is in dependency order. Everything above `publish-release` attaches an
asset to the draft or gates it; the two package-manager pushes come after it, and
[Package managers publish last](#package-managers-publish-last) explains why.

Ordering inside `publish-npm` is load-bearing: the unscoped `rom-weaver` alias
is a dependency-only pointer at `@rom-weaver/cli`, so publishing it first would
make installs resolve a version that is not on the registry yet.

### Containers reuse what the fan-out already built

`publish-containers` runs after `static-webapp` and `publish-npm` rather than
beside them, because both images are now assembled from artifacts those jobs
produce from the same commit:

| Image | Consumes | Instead of |
| --- | --- | --- |
| `rom-weaver-cli` | `cli-binary-linux-x64-gnu` and `cli-binary-linux-arm64-musl`, the binaries `publish-npm` builds | a second `cargo build --release` of the workspace |
| `rom-weaver-webapp` | `webapp-dist`, the bundle `static-webapp` packages | rustup + WASI SDK + binaryen + a cold wasm build |

The webapp image has a third build arg, `WASM`, which is not part of this
release path: it keeps the whole source build and only takes the compiled wasm
module from the context. CI uses it on the amd64 image leg; the release fan-out
never sets it, so a fallback-to-source release still compiles everything.

Each Dockerfile keeps both paths and picks with a build arg (`BINARY`, `DIST`)
that defaults to building from source, so `docker build` with no arguments -
what self-hosters and the `docker` job in `ci.yml` run - is unchanged. The
prebuilt half reads a `prebuilt/` directory out of the build context, which only
has to exist for the build that asks for it: BuildKit builds only the stages the
selected one depends on. `docker-publish.yml` downloads the artifact, falls back
to `source` when there is none, and so still works standalone under
`workflow_dispatch`, where there are no sibling jobs.

Two consequences worth knowing:

- The CLI runtime is `gcr.io/distroless/cc-debian13`, and the `debian13`
  (trixie) half of that is load-bearing, not bookworm. The reused binary is
  linked against the glibc of the `ubuntu-24.04` runner `publish-npm` builds on
  (2.39), which bookworm's 2.36 cannot load; trixie ships 2.41 and accepts both
  halves of the switch. `-cc` rather than `-base` supplies the
  libgcc/libstdc++ the vendored C deps expect. There is no shell in the image.
- `static-webapp` packages a raw webapp tarball. The webapp Dockerfile adds the
  `.br` siblings that its static-web-server expects (`compression-static` in
  `sws.toml`) after the shared raw artifact is copied. No `.gz` siblings: sws
  gzips on demand for the rare client without brotli, which keeps ~2.8 MB out
  of the image.
- `static-webapp` also owns the **build channel** for everything that is not a
  Cloudflare deploy. Its bundle becomes both `rom-weaver-webapp.tar.gz` and the
  container image, so it passes `ROM_WEAVER_CHANNEL` explicitly: `beta` for a
  prerelease, `prod` otherwise, on the same hyphen test as the rest of the
  prerelease routing. Without it a prerelease image would claim production
  while the deploy ladder put the same commit on `beta.rom-weaver.com`. The
  `deploy` job passes its own channel per target; an unset channel builds as
  `prod`, which is what a plain `npm run build` by a self-hoster should be.

A prebuilt build deliberately does **not** write the buildcache ref: it has
nothing expensive to cache, and exporting its handful of `COPY` layers would
evict the source layer graph that the `docker` job in `ci.yml` restores.

### Multi-arch images

Every published image is a manifest list covering `linux/amd64` and
`linux/arm64`, and **no leg of it runs under emulation**. Both `ci.yml` and
`docker-publish.yml` build one architecture per job on a runner of that
architecture - amd64 on `ubuntu-24.04`, arm64 on `ubuntu-24.04-arm` - through
the shared `.github/actions/docker-build-arch`, then join the results with
`.github/actions/docker-manifest`.

The alternative, one job emulating arm64 through QEMU, is what the first
multi-arch implementation did, and it is not close:

| Build | QEMU on `ubuntu-24.04` | Native |
| --- | --- | --- |
| CLI image, from source | 81 min | ~6 min |
| webapp image, from source | 121 min | ~9 min |
| webapp image, `DIST=prebuilt` | 5 min | ~1.5 min |

It took `ci.yml` on `main` from roughly 20 minutes to just over two hours.

Two mechanics follow from the split:

- The build legs push **by digest** (`push-by-digest=true`), claiming no tag.
  Nothing is tagged until a later job runs `docker buildx imagetools create`
  over both digests, so the two architectures can never race each other for
  `:nightly` and a half-published tag cannot exist. The digests travel between
  the jobs as artifacts rather than job outputs, because a matrix leg's outputs
  collapse to whichever leg finished last. The merge fails outright if it finds
  fewer than two - a manifest list quietly advertising one architecture pulls
  fine on amd64 and fails only for the arm64 users it exists for.
- Attestations name the **manifest list** digest, not either architecture's
  image: that is what a `docker pull` of the tag resolves against. Per-arch
  provenance and SBOMs still ride each leg's push.

The registry build cache is keyed per architecture
(`<image>:buildcache-amd64`, `<image>:buildcache-arm64`). One shared ref would
have each leg overwrite the other's layers on every run, so neither would ever
restore.

### Draft-first releases

Release Please creates the GitHub release as a **draft** (`"draft": true` in
`release-please-config.json`), every asset-producing job attaches to that draft,
and `publish-release` publishes it only once they have all succeeded. This is
what makes the repo's **immutable releases** setting workable: immutability is
stamped at publish time, and a published immutable release accepts no further
assets *and permanently reserves its tag name* - v0.6.0 was lost that way. A
failure anywhere in the fan-out now leaves a draft, which can be deleted and
re-cut at the same version.

A draft release has no tag until it is published, so every job builds from
`needs.release.outputs.sha` rather than `v${version}` - the reusable npm and
docker workflows take it as a required `sha` input. That also closes a race
they had before: under `workflow_call` they checked out `github.ref`, which is
`main`, so anything merged between the release pull request landing and the
fan-out finishing would have been built and published as the release.
The standalone Cargo and Docker dispatches fall back to `v${version}`, which by
then exists.

`cargo-publish.yml` is triggered by the resulting `v*` tag push instead of being
called by `release.yml`, so no crates.io publish ever runs inside the release
fan-out - the fan-out holds no registry credentials and cannot half-publish on
failure. Keying off the tag also orders it naturally last: the tag only exists
once the draft has been published.

`cargo-semver-checks` runs in `release.yml` as the `semver-check` job, not in
`cargo-publish.yml` where it used to live. By the time the tag exists the
release is published and immutable and the version can never be re-cut, so a
break found there could not be acted on; as a gate on `publish-release` a
failure leaves a deletable draft instead. It publishes nothing, so it needs no
registry credentials and runs alongside the publishing jobs.

It runs per-crate rather than `--workspace` so a crate with no published
baseline (a first release, or a newly added crate) is skipped instead of
failing the whole job.

### Package managers publish last

`publish-homebrew` and `publish-scoop` run **after** `publish-release`, not as
gates on it. Both write a manifest whose download URL is
`releases/download/vX.Y.Z/...`, and a draft release's assets are not publicly
downloadable - pushing them earlier put a live formula in the tap and a live
manifest in the bucket whose URLs 404 until the draft was published.

The ordering costs the property that a tap failure holds the draft, and that is
the better half of the trade. These two are the only publishes in the fan-out
that are trivially retryable: a git push to a repository we own, with no
registry state to reconcile. Rerunning the job fixes it. Everything that *is*
irreversible - npm, the container registry, the release itself - still gates
`publish-release`, and crates.io still runs after the tag for the same reason.

### Prerelease routing

One rule, applied in five places: a hyphen in the version means prerelease.

| Target | Stable | Prerelease |
| --- | --- | --- |
| npm dist-tag | `latest` | `beta` |
| docker tags | `X.Y.Z`, `X.Y`, `X` (≥1.0 only), `latest`, `beta`, `nightly` | `X.Y.Z`, `beta`, `nightly` |
| web channel | rom-weaver.com | beta.rom-weaver.com |
| GitHub release | normal | marked prerelease |
| Homebrew | formula updated | skipped |

The docker major tag starts at 1.0.0 because `0` would float across 0.5 → 0.6,
which semver treats as breaking.

`latest`/`beta`/`nightly` are the image-side names for the webapp's
prod/beta/nightly channels, and they cascade exactly like the
[deploy ladder](#deploy-channels): a publish refreshes its own channel
plus every less-stable one below it, so `beta` and `nightly` can never serve
code older than `latest`. The three tags therefore line up one-to-one with the
three hostnames in [Deploy channels](#deploy-channels):

| Ref | Web channel | Docker tag |
| --- | --- | --- |
| `vX.Y.Z` tag | rom-weaver.com, beta, nightly | `latest`, `beta`, `nightly` |
| `vX.Y.Z-alpha.N` tag | beta, nightly | `beta`, `nightly` |
| push to `main` | nightly | `nightly` |

The `main` row is the only one not published by `docker-publish.yml`. Its
images come from `ci.yml` - the CLI from the `docker` job's source build, the
webapp from `docker-prebuilt` - and carry the same change gating as the deploy
they mirror, so a push touching neither image leaves `nightly` where it is.
They are attested exactly like the release images: `provenance: mode=max`, an
SBOM, and an `actions/attest` signature pushed to the registry. Every published
image carries the same evidence regardless of which workflow built it.

Attestation is gated on the push rather than set outright, because it needs an
exporter that can carry attestations - the plain local build a pull request
runs is not one, and asking for provenance there fails the build.

### Build provenance

Every artifact the fan-out publishes carries signed provenance, so what a user
can verify does not depend on which channel they installed from:

| Artifact | Attested by |
| --- | --- |
| 9 CLI platform binaries | `actions/attest-build-provenance` in `npm-publish.yml`'s `platform` job |
| static webapp tarball | the same, in `release.yml`'s `static-webapp` |
| npm packages | `npm publish --provenance` (`scripts/ci/npm-publish-package.mjs`) |
| container images | `provenance: mode=max` + `actions/attest`, in `docker-publish.yml` for `latest`/`beta` and in `ci.yml` for `nightly` |

Two gaps remain, both because no mechanism exists: crates.io has no attestation
story, and neither does a Cloudflare Pages deploy. Homebrew and Scoop need none
of their own - both pin the release assets by sha256, so attesting the binaries
covers them.

Immutable releases separately make GitHub attest every release automatically,
with an `in-toto.io/attestation/release/v0.2` statement listing each asset's
digest. That is not build provenance and must not be mistaken for it: it says an
asset was in a release, which is equally true of one a stolen token uploaded to
the draft. It is also why every consumer query filters on
`predicate_type=https://slsa.dev/provenance/v1` - without the filter, the
automatic attestation answers and the check passes on anything in any release.

This replaced the `.sha256` sidecars that used to ship beside each asset, which
are no longer published. They were written by the job that wrote the binary, so
they proved the download was intact and nothing about where it came from. The
attestation covers both: it ties the asset to a workflow run and commit, and
altered bytes hash to something it does not cover.

Attestations live in the repository's attestation store, not in the release's
asset list. That is why adding them does not interact with
[immutable releases](#draft-first-releases): nothing is attached to the draft,
and the step is safe on a rerun and after the release is published.

The consumer side is a single query against the digest - see
[Verifying a download](../hosting/cli.md#verifying-a-download), where both install scripts'
check and the `gh attestation verify` route for a file downloaded by hand are
written out.

#### Testing it without cutting a release

The attest steps run only during a release, which is the one moment their
failure costs the most: a 403 there strands a draft that has already published
to npm. `attestation-dry-run.yml` (dispatch only) proves the wiring beforehand.
It attests a throwaway file two ways - directly, and through a `workflow_call`
into `attestation-dry-run-called.yml` - because the token cap is the failure
mode worth catching: a reusable workflow receives the calling job's permissions
and never more, so a grant declared only in the called workflow fails. Then it
checks the result on Linux, macOS, and Windows the way each install script does,
which is the only coverage `install.ps1`'s PowerShell path has anywhere.

It is dispatch only because every run writes a permanent public attestation
record; firing it per push would be noise in the repository's attestation list.

The installers' fallback is duplicated into that workflow rather than invoked,
because `install.sh` verifies only an asset it downloaded from a release and the
dry run's subject is not one. `scripts/install.test.mjs` covers the same code
against a captured real API response
(`test/fixtures/attestations-response.json`), so the duplication is checked from
both ends: the fixture proves the shell agrees with GitHub's response shape, and
the dry run proves it agrees with a live attestation.

## Actions cache budget

GitHub gives the repository 10 GiB and evicts least-recently-used entries once
that fills. Three mechanisms keep it under the cap; they exist because it was
exceeded (11.46 GB, with 5.1 GB parked in six closed Dependabot pull requests,
evicting the `main` caches every cold run depends on).

1. `save-if: github.ref == 'refs/heads/main'` on the cargo cache, so branch
   runs restore but never write.
2. `cache-cleanup.yml` runs every six hours and deletes two kinds of dead
   weight: caches belonging to closed and merged pull requests, and superseded
   generations - entries whose key family (the key minus its trailing content
   hashes) has a newer save in the same ref scope, which restores prefix-match
   past but that still occupy hundreds of megabytes each. `wasm-prod` is
   exempt from generation pruning: it restores by exact fingerprint key, so an
   older ~4 MB entry is still what a branch based on older `main` asks for.
   The job warns in its summary if usage is still above 9 GiB afterwards.
3. `parity.yml` caches only its release CLI binary, keyed without restore
   prefixes over the Rust/C source and toolchain inputs, and saves only on
   `main`. The nightly check still installs and runs the current external tools.

The cleanup is **scheduled, not triggered by `pull_request: closed`**:
workflows triggered by Dependabot or a fork get a read-only `GITHUB_TOKEN`, so
a close-triggered job could not delete anything for exactly the traffic that
produces most of the garbage.

### Why the Docker build cache is not in this budget

The image builds cache to `ghcr.io/rom-weaver/<image>:buildcache-<arch>`, not
`type=gha`.
Publishing runs only when a release pull request merges, and Actions entries are
evicted after seven days without a read, so a gha cache was reliably cold by the
next release while `mode=max` still wrote the whole layer graph - Rust builder
stage included - into the 10 GiB budget above. Those entries were also beyond
the cleanup's reach, which reaps closed-pull-request scopes while these were
written on a tag. A registry cache costs no Actions budget, expires on no timer,
and the `docker` job in `ci.yml` reads the same refs.

Cache **mounts** (`--mount=type=cache`) are a separate mechanism and remain
local-only: BuildKit exports them to neither backend, so CI always pays a cold
compile for the layer that runs the build.

## Secrets

| Secret | Used by | For |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `ci.yml` deploy | Pages Direct Upload |
| `RELEASE_PLEASE_TOKEN` | `release.yml` | Opening the release pull request |
| `HOMEBREW_TAP_TOKEN` | `release.yml` | Pushing to the tap repository |
| `SCOOP_BUCKET_TOKEN` | `release.yml` | Pushing to the Scoop bucket repository |
| `GITHUB_TOKEN` | everywhere | ghcr.io, releases, statuses, cache deletion |

crates.io needs no stored secret - `rust-lang/crates-io-auth-action` mints a
short-lived token from the workflow's OIDC identity.

npm trusted publishing likewise uses the workflow's OIDC identity and needs no
stored npm secret.

Permissions are declared per workflow and widened per job rather than granted
workflow-wide; `cache-cleanup.yml` starts from `permissions: {}` and takes only
`actions: write` and `pull-requests: read`.

## Reproducing CI locally

The pre-commit hooks select lint checks from the staged paths. CI reuses those
tasks over the whole tree, then adds tests, builds, publishability checks, and
the macOS/Windows Rust legs. `mise run ci` is the broad local gate; use the
individual commands below when narrowing a failure or matching a specific job.

```bash
mise run ci                                                  # broad local gate

mise run actionlint ::: docs-lint ::: shellcheck ::: hadolint # repo-lint
node --test scripts/ci/classify-changes.test.mjs             # change boundaries
node --test scripts/ci/docker-matrix.test.mjs                # image/arch leg planning
node --test scripts/ci/wasm-runtime-coverage.test.mjs        # wasm_runtime vs. the suite
mise run fmt ::: clippy ::: typegen-check ::: whitespace ::: thread-guards
mise run test-rust ::: licenses-check ::: deny-policy ::: machete # rust-host
cargo publish --workspace --locked --dry-run --no-verify     # rust-host
mise run wasm-check                                          # local threaded-target check
mise run build-wasm-prod                                     # wasm
npm test                                                     # repository tooling tests
npm run docs:lint                                            # owned Markdown
npm --prefix packages/rom-weaver-webapp run lint             # webapp lint fan-out
npm --prefix packages/rom-weaver-webapp run icons:channels:check
npm --prefix packages/rom-weaver-webapp run test:unit
npm --prefix packages/rom-weaver-webapp run test:browser:wasm
npm --prefix packages/rom-weaver-webapp run test:browser
npm --prefix packages/rom-weaver-webapp run test:e2e:webapp
npm --prefix packages/rom-weaver-webapp run build
```

`actionlint` is shellcheck-aware and also lints inline workflow `run:` scripts;
the separate `shellcheck` task covers the tracked shell files, and `npm test`
covers the Node.js tooling. `docker` is
conditional on image-plumbing changes and is most directly reproduced with the
source-build commands in the [self-hosting guide](../hosting/self-hosting.md);
`docker-prebuilt` is `docker build --build-arg DIST=prebuilt .` with the bundle
staged under `prebuilt/`; the CLI job uses `BINARY=prebuilt` when its packaging
inputs change.

## Gotchas

- **Never set `RUSTFLAGS` in the wasm build job.** Cargo *replaces* configured
  target flags instead of extending them, silently dropping shared memory, LTO,
  and exports. Overriding it for `wasm-check` is safe because nothing is
  linked.
- **`cargo publish --dry-run` exits 0 when a package sets `publish = false`**,
  so that CI gate becomes a silent no-op rather than an error.
- **A glob of `*[bot]` does not match a bot login.** In a bash `[[ ]]` pattern
  `[bot]` is a character class, so it matches a trailing b, o or t - never the
  literal `[bot]` every GitHub App account ends with. `cla-gate.mjs` escapes the
  brackets before matching; any new glob-matching code needs the same.
- **The root `package-lock.json` needs generated `@rom-weaver/*` optional
  entries.** The scope is not fully published when Release Please opens a new
  release PR, so `scripts/sync-version.mjs` writes local platform-package lock
  entries without registry `resolved`/`integrity` fields. A lefthook
  `root-lock-sync` hook guards this.
- **`COPY --chmod` silently drops the sticky bit.** It takes the low nine bits
  only, so `--chmod=1777` yields `drwxrwxrwx`, not `drwxrwxrwt`. Naming a
  directory as the COPY *source* does not preserve its mode either - only its
  contents are contributed, and the destination is recreated 0755. The CLI
  image needs a sticky-writable `/work` and has no shell to `mkdir` with, so it
  builds the directory in a throwaway stage and copies the **parent**, which
  does preserve the mode of everything inside. Verify with `ls -ld /work` from
  a shell-bearing stage; `drwxrwxrwt` is the passing result.
