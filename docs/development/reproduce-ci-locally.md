# Reproduce a CI failure locally

Use the failed job name to choose a local check. Use the broad gate when you need to check the complete change. For what each workflow is and when it runs, see [Continuous integration](ci.md).

<!-- START doctoc -->
## Table of contents

- [Match a specific job](#match-a-specific-job)
- [Prevent repeat failures](#prevent-repeat-failures)
- [Reproduce the Docker jobs](#reproduce-the-docker-jobs)
- [Check the complete change](#check-the-complete-change)
- [Still red in CI but green locally?](#still-red-in-ci-but-green-locally)
- [Additional correctness checks](#additional-correctness-checks)
  - [Prove a bug-fix regression test](#prove-a-bug-fix-regression-test)

<!-- END doctoc -->

## Match a specific job

```bash
mise run actionlint ::: docs-lint ::: shellcheck ::: hadolint # repo-lint
node --test scripts/ci/classify-changes.test.mjs             # change boundaries
node --test scripts/ci/docker-matrix.test.mjs                # image/arch leg planning
node --test scripts/ci/wasm-runtime-coverage.test.mjs        # wasm_runtime vs. the suite
mise run fmt ::: clippy ::: typegen-check ::: whitespace ::: thread-guards
mise run test-rust # rust-host
mise run licenses-check ::: deny-policy ::: machete # rust-lint
mise run identify-data
cargo publish --workspace --locked --dry-run --no-verify --allow-dirty # rust-host
mise run wasm-check                                          # local threaded-target check
mise run build-wasm-prod                                     # wasm
npm test                                                     # repository tooling tests
npm run docs:lint                                            # owned Markdown
npm --prefix packages/rom-weaver-webapp run lint             # webapp lint fan-out
npm --prefix packages/rom-weaver-webapp run icons:channels:check
npm --prefix packages/rom-weaver-webapp run test:scripts
npm --prefix packages/rom-weaver-webapp run test:unit
npm --prefix packages/rom-weaver-webapp run test:browser:wasm
npm --prefix packages/rom-weaver-webapp run test:browser
npm --prefix packages/rom-weaver-webapp run test:e2e:webapp
npm --prefix packages/rom-weaver-webapp run build
npm --prefix packages/rom-weaver-webapp run test:performance     # performance gates
```

The performance gates need the production WASM artifact and the webapp build first (`mise run build-wasm-prod`, then `run build` above). The audit picks a free port unless `PORT` is set.

`actionlint` is shellcheck-aware and lints inline workflow `run:` scripts; the separate `shellcheck` task covers the tracked shell files, and `npm test` covers the Node.js tooling.

## Prevent repeat failures

Before pushing webapp or published-doc changes, check the generated bundle, even when lint and pre-commit hooks pass. Documentation changes can grow the search JavaScript and HTML; UI changes can grow shared CSS and JavaScript.

1. Prepare the worktree with the [development guide](development.md#linked-worktrees). Use a production WASM build from the current sources (`mise run build-wasm-prod`) before measuring sizes; a development module is not comparable to CI's optimized artifact.
2. From the repository root, build the production channel and check its sizes:

   ```bash
   ROM_WEAVER_CHANNEL=prod npm --prefix packages/rom-weaver-webapp run build
   npm --prefix packages/rom-weaver-webapp run check:size
   ```

3. Investigate unexpected growth using the failing asset group and its raw/Brotli measurements. Remove accidental imports or duplicated assets before considering a budget change. For intentional growth, explain the cost and propose the corresponding budget update in the same change; do not raise limits just to silence a failure.
4. For UI changes, also run the affected browser tests and `test:e2e:a11y`. Run `test:e2e:webapp:webkit` for Safari-sensitive behavior. Reproduce failures against the same production channel as CI. When changing tutorial steps, Settings controls, or navigation, check the browser assertions, E2E locators, and screenshot targets together. Prefer stable state attributes for readiness; keep assertions for intended step counts and content.

Choose browser test files from the behavior you changed. These are starting points, not an exhaustive dependency map; include other affected tests and run the full browser suite when shared behavior makes the selection unclear. Paths below are relative to `packages/rom-weaver-webapp/tests/browser/`.

| Changed behavior | Browser test files |
| --- | --- |
| Docs navigation, tutorial entry points, app shell | `webapp.browser.test.js` |
| Remote URL imports and restoring imported files | `remote-url-session.browser.test.js` |
| Create source selection, swapping, and queues | `create-form-queue.browser.test.js` |
| Settings state and persistence | `settings-context.browser.test.js`, `settings-persistence.browser.test.js` |
| Codec menu interactions | `codec-combobox.browser.test.js` |

From the webapp directory, pass one or more files to the existing runner. For example:

```bash
cd packages/rom-weaver-webapp
npm run test:browser -- tests/browser/webapp.browser.test.js
```

After the production build and size check above, reuse that bundle for accessibility or E2E checks, also from the webapp directory:

```bash
ROM_WEAVER_CHANNEL=prod ROM_WEAVER_E2E_USE_PREBUILT_DIST=1 npm run test:e2e:a11y
```

The accessibility shard also checks keyboard navigation at desktop and mobile widths: the skip link preserving the current route and moving focus to main content, Settings and reset dialog names and focus, Escape and cancellation focus return, saving settings, and opening the file picker. It asserts focused ARIA snapshots alongside accessible-name and role checks. The raw and archive Apply journeys select files through the keyboard file picker and activate Apply through the tab order and Enter, then verify the downloaded bytes. These checks run headlessly in Chromium and WebKit using the existing Playwright dependency.

Treat these as regression checks, not screen-reader certification. They do not run NVDA or VoiceOver or verify spoken live-region announcements. For those checks, use a real screen reader to import files, select and reorder patches, apply a patch, and confirm progress, errors, and completion announcements. Guidepup can automate real-reader journeys on Windows (NVDA) or macOS (VoiceOver) with a headed browser; it requires a separate platform runner.

Use `test:e2e:webapp` for all Chromium E2E scenarios or `test:e2e:webapp:webkit` for WebKit with the same environment. Rebuild and recheck sizes after changes to build inputs; the prebuilt option validates the channel and required files, not source freshness. Do not reuse a bundle from an earlier revision. Running E2E without these variables builds again and defaults to the development channel.

For webapp build or tooling changes, run `npm run test:scripts` from the webapp directory. From the repository root, `node --test scripts/ci/*.test.mjs` checks the change classifier and its WASM dependency coverage without compiling Rust or launching browsers. The pre-commit hook runs these CI script tests when CI files, webapp JavaScript/TypeScript, or fixture trees change, including runtime imports outside `src/wasm`.

If the final `Webapp` job reports `webapp-size=failure`, open **Build WASM module + webapp → Asset size gates** and its size summary. The build job can be green because that step deliberately continues on error; the final aggregate still blocks the change. `gh run view --log-failed` alone can miss the size diagnostics in that successful job. Read the build job's full log.

Retry browser crashes or connection failures only after checking the first error. A repeated missing locator, changed count, accessibility violation, or size-budget failure needs a fix; increasing timeouts or rerunning the same assertions does not address it.

## Reproduce the Docker jobs

`docker` is conditional on image-plumbing changes and is most directly reproduced with the source-build commands in the [self-hosting guide](../hosting/self-hosting.md). The `docker` job passes `IDENTIFY_DATA=prebuilt` to every leg it builds. For the CLI image it stages `target/identify-release/share`; run `mise run identify-data` and `node scripts/build-identify-release-data.mjs --tree-only` before that variant. For the webapp image it stages the built packs under `target/identify-data/v1`; run `mise run identify-data` and `cp -a crates/rom-weaver-cli/data/identify/v1 target/identify-data/v1` before that variant.

`docker-prebuilt` is `docker build --build-arg DIST=prebuilt .` with the bundle staged under `prebuilt/`. The CLI job uses `BINARY=prebuilt` when its packaging inputs change.

<a id="run-the-broad-gate-first"></a>

## Check the complete change

After the matching check passes, run the complete local gate:

```bash
mise run ci
```

The pre-commit hooks select lint and CI script checks from staged paths. CI uses the same tasks, then adds tests, builds, publishability checks, and macOS and Windows Rust jobs. `mise run ci` runs repository tests, webapp script tests, lint, and unit tests, then builds the production webapp once and checks its asset sizes before browser suites run. E2E reuses that same production bundle. It does not reproduce those other operating systems or run every hosted check: run Lighthouse separately with `test:performance`, and use the matching commands above for publishability checks.

## Still red in CI but green locally?

Check the [CI constraints](ci.md#gotchas), including Cargo target-flag replacement and the publishability check for packages with `publish = false`. Compare the failed job's toolchain, environment variables, and command with the local run.

## Additional correctness checks

Install dependencies with the worktree setup helper before invoking the AST guards. Tools are pinned in `.config/mise.toml`; expensive analyses have independent entry points. Run the fast checks from the repository root:

```bash
mise run quality-architecture
mise run quality-selection
mise run quality-guardrails main
node --test scripts/quality-*.test.mjs scripts/coverage-rust.test.mjs
```

Review the JSON guardrail findings even when the command succeeds: `review` means intentional/uncertain evaluation changes need attention; `error` blocks the gate. Use a fetched target ref or exact base SHA. Missing merge-base history is an error, not an empty successful diff. Local guardrail comparison includes tracked working changes; stage new files so Git can include them in the comparison.

Run focused or broad mutation evidence:

```bash
mise run quality-mutation diff main
mise run quality-mutation broad
mise run quality-mutation broad 0/64
mise run quality-mutation list
```

Inspect `.agent/quality-mutation/summary.json` and `mutants.out` for surviving locations, build failures and timeouts. A timeout or failure to compile is not a test catch. Investigate an apparent equivalent survivor before proposing a narrow documented exclusion. Do not relax limits merely to make a run green.

Run the independent property checks:

```bash
cargo test -p rom-weaver-patches --test behavior_properties
cargo test -p rom-weaver-checksum edge_checksum_chunking
cargo test -p rom-weaver-core single_money_edit_preserves
```

Set `PROPTEST_CASES=256` for deeper runs. Preserve a reported proptest regression seed when fixing failures. The patch suite includes boundary sizes, independent streaming apply paths, thread budgets and an explicit UPS scan/chunk boundary matrix.

Run worker lifecycle and OPFS resource checks from the webapp package after preparing the current WASM artifact:

```bash
npm run test:unit -- worker-lifecycle-properties.test.ts
npm run test:browser:wasm -- browser-opfs-many-entries.test.mjs
```

Compare live/peak handles and buffered bytes at fixed concurrency as entry counts increase. Worker counts include the documented pool headroom. These are deterministic resource assertions, not wall-clock performance budgets.

Prepare the pinned nightly toolchain for fuzz, sanitizer and Miri lanes:

```bash
rustup toolchain install nightly-2026-08-25 --component rust-src,miri
mise run quality-fuzz smoke
mise run quality-fuzz deep
mise run quality-sanitizer
mise run quality-miri
mise run quality-kani
```

Fuzz artifacts live under `fuzz/artifacts/<target>/`. Replay one with the pinned `cargo +nightly-2026-08-25 fuzz run <target> <crash-path>`. Minimize with the same command's `tmin` subcommand. Promote the minimized bytes into an ordinary test that checks the intended behavioral error, preferably expressing small inputs directly rather than adding binary blobs. The empty-filename CUE/GDI regression is an example. Targets also include `bundle_parse`, `dcp_zip` and `iso9660`; pass a target after `smoke` or `deep` to focus the run. The bundle harness activates the CLI-only `fuzzing` seam without enabling it in normal release builds. Do not commit generated corpus growth, target directories or crash artifacts. Miri/sanitizer discovery and instrumentation records live under the matching `.agent/quality-*` directory; Kani retains its solver log and bounded assumptions.

Build the native candidate and verify the frozen reference:

```bash
cargo build --locked -p rom-weaver-cli --bin rom-weaver
mise run quality-reference
```

The command reports tool provenance and hashes. It never rewrites the frozen oracle. Use the existing live parity workflow separately for current upstream compatibility.

Run coverage or opt into nightly branch coverage (also install `llvm-tools-preview` for that nightly):

```bash
mise run coverage-rust
mise run coverage-rust-branch
mise run quality-diff-coverage main dist/coverage/rust/lcov.info
```

Use only LCOV produced from the current candidate. `changed-lines.json` separates covered, zero-hit, and not-measured lines and branch records; not-measured includes comments and unsupported/instrumentation-omitted code. The stable Rust lane has no branch instrumentation; browser LCOV may have decision records. Check selection logs before interpreting percentages.

### Prove a bug-fix regression test

Invoke `quality-regression-proof` with a base ref, package, integration test target, exact test name, a specific behavioral diagnostic and one or more `--test-file` paths. It archives the merge base into task scratch, overlays only Rust tests, and builds base/candidate into separate target directories. Production files and manifests cannot be overlaid. Required fixture/data dependencies must already be available; their absence is an unproven setup failure, not proof.

For the CUE regression added by fuzzing, the arguments are:

```text
--base main
--package rom-weaver-core
--target disc_sheet_regressions
--test empty_quoted_disc_sheet_filename_is_rejected
--diagnostic "empty filename must be a validation error"
--test-file crates/rom-weaver-core/tests/disc_sheet_regressions.rs
```

Pass them together to `mise run quality-regression-proof`. An optional `--features` argument selects required features. The tool requires the exact named test to fail with the supplied diagnostic and `0 passed; 1 failed` at base, then pass with `1 passed; 0 failed` at candidate. Compile errors, unrelated failures, timeouts and zero-test runs produce `unproven` evidence and a nonzero exit. A new manifest/feature needed by the test may make this mechanism inappropriate; report that limitation rather than transplanting the fix into the base.

An agent's report should name the base SHA, candidate SHA plus uncommitted state if applicable, exact command/test, expected assertion, both outcomes, and the `proof.json`/log paths. Do not simply say “red then green.” Preserve needed evidence before cleaning disposable task scratch.
