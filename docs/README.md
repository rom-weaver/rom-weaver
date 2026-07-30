# rom-weaver documentation

Choose the guide that matches what you are trying to do.

<!-- START doctoc -->
## Table of contents

- [Use rom-weaver](#use-rom-weaver)
- [Deploy](#deploy)
- [Integrate](#integrate)
- [Develop and contribute](#develop-and-contribute)

<!-- END doctoc -->

## Use rom-weaver

- [Documentation home](./usage/README.md): browser and CLI entry points, guided
  samples, installation, self-hosting, every guide, and quick answers.
- [Browser usage](./usage/get-started.md): what a patch is and one
  safe worked example with the included homebrew files.
- [Apply patches](./usage/apply-rom-patches.md): the complete Weave workflow,
  with focused screenshots for desktop, mobile, light, and dark themes.
- [Create patches](./usage/create-rom-patches.md): compare Original and
  Modified, download a patch, then test that downloaded patch.
- [Create bundles](./usage/create-bundles.md): package and verify a repeatable,
  patch-only release in the Weave webapp.
- [FAQ](./usage/faq.md): privacy, matching ROMs, patch formats, bundles,
  offline use, devices, and choosing between browser and CLI.
- [CLI usage](./hosting/cli.md): installation, common workflows, command reference,
  supported formats, compression, checksums, trimming, and JSON output.
- [Man pages](./hosting/cli.md#man-pages): generate `rom-weaver(1)` and one page per
  visible CLI command directly from Clap.
- [Screenshots](./development/screenshots.md): reproducible, focused desktop
  and mobile captures plus the runnable sample ROMs before and after patching.
- [Webapp masthead metadata](./hosting/webapp-runtime-status.md): the version, SHA,
  thread, PWA, and service-worker labels.
- [`rom-weaver-bundle.json` schema](rom-weaver-bundle-v1.schema.json): machine-readable
  schema for distributable patch workflows.

## Deploy

- [Self-hosting](./hosting/self-hosting.md): Docker, static deployment, reverse proxies,
  subpaths, HTTPS, and COOP/COEP.
- [Hosted deployment channels](./development/ci.md#deploy-channels): production, beta, nightly,
  and pull-request previews, including their stability and search-indexing policy.
- [Runtime configuration](./hosting/env-vars.md): native, WASM, webapp, test, and build
  configuration knobs.

## Integrate

- [Webapp integration](./hosting/webapp-integration.md): preload `?bundle=...` and
  `?rom=...&patch=...` URLs or feed same-origin OPFS files into the webapp pipeline.
- [Browser WASM runtime](../packages/rom-weaver-webapp/src/wasm/README.md):
  the OPFS runner and worker-client API surface.

## Develop and contribute

- [Contribution guide](../CONTRIBUTING.md): reporting bugs, proposing changes,
  validation, and contribution licensing.
- [Commit conventions](./development/commits.md): pull request title format, allowed types and
  scopes, breaking changes, and the footers that steer a release.
- [Contributor License Agreement](../CLA.md): the one-time signature every
  contributor gives, and what it does and does not grant.
- [Code of conduct](../.github/CODE_OF_CONDUCT.md): expectations for respectful project
  participation and reporting conduct concerns.
- [Security policy](../.github/SECURITY.md): supported versions and private
  vulnerability reporting.
- [Development guide](./development/development.md): prerequisites, setup, native and WASM
  builds, the dev server, tests, generated files, and linked worktrees.
- [Architecture](./development/ARCHITECTURE.md): workspace layout, crate graph, command core,
  browser boundary, OPFS, workers, and test organization.
- [Performance](./development/performance.md): the benchmark harnesses, recorded results
  against chdman, dolphin-tool, 7zz, and Info-ZIP, and how to reproduce them.
- [Browser concurrency](./development/browser-concurrency.md): shared memory, worker protocols,
  the thread-start barrier, the OPFS proxy, and file ownership.
- [Mobile Safari verification](./development/mobile-safari-verification.md): automated and
  real-device checks for WebKit, OPFS, memory pressure, and PWA behavior.
- [Vendored third-party code](./development/vendor-code.md): what is vendored and why, the
  crates.io publishing constraint, and how to return each one to upstream.
- [Continuous integration](./development/ci.md): every workflow, the required gate, deploy
  channels, shared actions, caching, secrets, and how to reproduce CI locally.
- [Release guide](../.github/RELEASING.md): first-release setup, trusted
  publishing, deployment channels, and retry steps.
- [References](./development/references.md): format specifications and upstream reference
  implementations.
- [Reversible trim footer](./development/trim-revert-footer.md): the small footer that allows
  an exact byte-for-byte trim reversal.
