# Reproduce a CI failure locally

Use the failed job name to choose a local check. Use the broad gate when you need to check the complete change. For what each workflow is and when it runs, see [Continuous integration](ci.md).

<!-- START doctoc -->
## Table of contents

- [Match a specific job](#match-a-specific-job)
- [Prevent repeat failures](#prevent-repeat-failures)
- [Reproduce the Docker jobs](#reproduce-the-docker-jobs)
- [Check the complete change](#check-the-complete-change)
- [Still red in CI but green locally?](#still-red-in-ci-but-green-locally)

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
