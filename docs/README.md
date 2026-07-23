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

- [CLI guide](cli.md): installation, common workflows, command reference,
  supported formats, compression, checksums, trimming, and JSON output.
- [Man pages](cli.md#man-pages): generate `rom-weaver(1)` and one page per
  visible CLI command directly from Clap.
- [Screenshots](screenshots.md): desktop and mobile views of the main workflows.
- [`rom-weaver-bundle.json` schema](rom-weaver-bundle-v1.schema.json): machine-readable
  schema for distributable patch workflows.

## Deploy

- [Self-hosting](self-hosting.md): Docker, static deployment, reverse proxies,
  subpaths, HTTPS, and COOP/COEP.
- [Hosted deployment channels](ci.md#deploy-channels): production, beta, nightly,
  and pull-request previews, including their stability and search-indexing policy.
- [Runtime configuration](env-vars.md): native, WASM, webapp, test, and build
  configuration knobs.

## Integrate

- [Webapp integration](webapp-integration.md): preload `?bundle=…` and
  `?rom=…&patch=…` URLs or feed same-origin OPFS files into the webapp pipeline.
- [Browser WASM runtime](../packages/rom-weaver-webapp/src/wasm/README.md):
  the OPFS runner and worker-client API surface.

## Develop and contribute

- [Contribution guide](../.github/CONTRIBUTING.md): reporting bugs, proposing changes,
  validation, and contribution licensing.
- [Code of conduct](../.github/CODE_OF_CONDUCT.md): expectations for respectful project
  participation and reporting conduct concerns.
- [Security policy](../.github/SECURITY.md): supported versions and private
  vulnerability reporting.
- [Development guide](development.md): prerequisites, setup, native and WASM
  builds, the dev server, tests, generated files, and linked worktrees.
- [Architecture](ARCHITECTURE.md): workspace layout, crate graph, command core,
  browser boundary, OPFS, workers, and test organization.
- [Browser concurrency](browser-concurrency.md): shared memory, worker protocols,
  the thread-start barrier, the OPFS proxy, and file ownership.
- [Mobile Safari verification](mobile-safari-verification.md): automated and
  real-device checks for WebKit, OPFS, memory pressure, and PWA behavior.
- [Vendored third-party code](vendor-code.md): what is vendored and why, the
  crates.io publishing constraint, and how to return each one to upstream.
- [Continuous integration](ci.md): every workflow, the required gate, deploy
  channels, shared actions, caching, secrets, and how to reproduce CI locally.
- [Release guide](../.github/RELEASING.md): first-release setup, trusted
  publishing, deployment channels, and retry steps.
- [References](references.md): format specifications and upstream reference
  implementations.
- [Reversible trim footer](trim-revert-footer.md): the small footer that allows
  an exact byte-for-byte trim reversal.
